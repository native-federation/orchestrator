import type { ExternalName, shareScope } from 'lib/core/1.domain';
import type { LogHandler } from '../../config/log.contract';
import type { PoolMember, PoolName } from './pool.types';

/** Matches a scoped npm package name, capturing the scope without the leading `@`. */
const SCOPED_PACKAGE = /^@([^/]+)\//;

// Disjoint-set union (union by size + iterative path halving — loop-based to avoid stack growth in
// the browser). String node keys are interned to integers so the hot path indexes plain arrays.
function createDSU() {
  const ids = new Map<string, number>();
  const parent: number[] = [];
  const size: number[] = [];

  const intern = (key: string): number => {
    let id = ids.get(key);
    if (id === undefined) {
      id = parent.length;
      ids.set(key, id);
      parent.push(id);
      size.push(1);
    }
    return id;
  };

  const findRoot = (x: number): number => {
    while (parent[x]! !== x) {
      parent[x] = parent[parent[x]!]!; // path halving
      x = parent[x]!;
    }
    return x;
  };

  return {
    union(a: string, b: string): void {
      let rootA = findRoot(intern(a));
      let rootB = findRoot(intern(b));
      if (rootA === rootB) return;
      if (size[rootA]! < size[rootB]!) [rootA, rootB] = [rootB, rootA];
      parent[rootB] = rootA;
      size[rootA] = size[rootA]! + size[rootB]!;
    },

    // Interns the key if unseen — an isolated key is its own component.
    component(key: string): number {
      return findRoot(intern(key));
    },
  };
}

// Namespaced node keys, NUL-separated so no kind or `(remote, …)` pair can alias another. Both tag
// and scope nodes are per remote, so every edge is remote-local and pools merge only through a
// shared member — see docs/version-resolver.md §"The provenance promise", the auto-pooling bullet.
const extNode = (name: ExternalName): string => `ext\x00${name}`;
const tagNode = (remote: string, tag: string): string => `tag\x00${remote}\x00${tag}`;
const scopeNode = (remote: string, scope: string): string => `scope\x00${remote}\x00${scope}`;

export type PoolEdge = { remote: string; tag: string };

// A poolable external's edges: `scope` (auto-pooling, per declaring remote) and any declared `tags`.
// `remotes` is every remote declaring the external, which is what makes auto-pooling remote-local.
// `value` is the payload returned per member — a `SharedExternal` for init, a package name for dynamic.
export type PoolCandidate<T> = {
  name: ExternalName;
  scope?: string;
  tags: readonly PoolEdge[];
  remotes: readonly string[];
  value: T;
};

// npm scope of a package when auto-pooling is on (`@framework/core` -> `framework`); undefined for
// unscoped names or when auto-pooling is off.
export function autoScope(name: string, useAutoExternalPooling: boolean): string | undefined {
  return useAutoExternalPooling ? SCOPED_PACKAGE.exec(name)?.[1] : undefined;
}

// The package a secondary entrypoint belongs to, or undefined when the name is already a package.
// An npm package name carries at most one `/` (after a leading `@scope`), so any deeper segment is a
// subpath of the package above it: `@framework/core/testing` -> `@framework/core`, `rxjs/operators`
// -> `rxjs`.
export function owningPackage(name: ExternalName): ExternalName | undefined {
  const depth = name.startsWith('@') ? 2 : 1;
  let cut = -1;
  for (let seen = 0; seen < depth; seen++) {
    cut = name.indexOf('/', cut + 1);
    if (cut === -1) return undefined;
  }
  return name.slice(0, cut);
}

/**
 * Group one shareScope's candidates into pools by shared membership: pool = connected component of a
 * graph whose edges are all remote-local — `external -> scope@remote` for each remote that declares
 * it (auto-pooling) and `external -> tag@remote` for each declared tag — plus an unconditional
 * `entrypoint -> package` edge. A pool therefore forms exactly when some remote declares members
 * from both sides. See docs/version-resolver.md.
 *
 * Returns only real pools (>=2 members), keyed by and iterated in order of their canonical name
 * (smallest member — reload-stable). An explicit-tag member that pooled with nothing is warned
 * (likely typo or missing sibling); auto-scope singletons stay silent.
 */
export function groupByMembership<T>(
  candidates: readonly PoolCandidate<T>[],
  log?: LogHandler
): Map<PoolName, T[]> {
  const dsu = createDSU();
  const tagged = new Set<ExternalName>();
  const joined = new Set<ExternalName>();

  // A `pool` tag replaces auto-pooling for the remote that declared it, per npm scope: one tag on a
  // member must not drag every other package of that scope in behind it.
  const tagRules = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.scope === undefined) continue;
    for (const edge of candidate.tags) tagRules.add(`${edge.remote}\x00${candidate.scope}`);
  }

  for (const candidate of candidates) {
    for (const edge of candidate.tags) {
      dsu.union(extNode(candidate.name), tagNode(edge.remote, edge.tag));
      tagged.add(candidate.name);
      joined.add(candidate.name);
    }
    if (candidate.scope === undefined) continue;
    for (const remote of candidate.remotes) {
      if (tagRules.has(`${remote}\x00${candidate.scope}`)) continue;
      dsu.union(extNode(candidate.name), scopeNode(remote, candidate.scope));
      joined.add(candidate.name);
    }
  }

  // An entrypoint follows its package into whatever pool the package joins. Without this a remote
  // that tags anything in a scope drops the auto edge for its own flat entrypoints too, and they
  // leave pooling entirely — measured as a torn package.
  const declared = new Set(candidates.map(c => c.name));
  for (const candidate of candidates) {
    const owner = owningPackage(candidate.name);
    if (owner !== undefined && declared.has(owner))
      dsu.union(extNode(candidate.name), extNode(owner));
  }

  const byComponent = new Map<number, { name: ExternalName; value: T }[]>();
  for (const candidate of candidates) {
    const root = dsu.component(extNode(candidate.name));
    const members = byComponent.get(root) ?? byComponent.set(root, []).get(root)!;
    members.push({ name: candidate.name, value: candidate.value });
  }

  const pools: { name: ExternalName; value: T }[][] = [];
  for (const members of byComponent.values()) {
    // Joinedness is a property of the component, not of one member: an entrypoint contributes no edge
    // of its own yet pools with the package that does.
    if (!members.some(m => joined.has(m.name))) continue;

    members.sort((a, b) => a.name.localeCompare(b.name));
    if (members.length < 2) {
      const only = members[0]!;
      if (tagged.has(only.name)) {
        log?.warn(
          3,
          `[${only.name}] declares a 'pool' tag but no other external joined its pool; likely a typo or a missing sibling.`
        );
      }
      continue;
    }
    pools.push(members);
  }

  pools.sort((a, b) => a[0]!.name.localeCompare(b[0]!.name));
  return new Map(pools.map(members => [members[0]!.name, members.map(m => m.value)]));
}

/** Init-path grouping: build candidates from the stored shared externals of one shareScope. */
export function buildPools(
  sharedExternals: shareScope,
  useAutoExternalPooling: boolean,
  log?: LogHandler
): Map<PoolName, PoolMember[]> {
  const candidates = Object.entries(sharedExternals).map<PoolCandidate<PoolMember>>(
    ([name, external]) => ({
      name,
      scope: autoScope(name, useAutoExternalPooling),
      tags: external.versions.flatMap(v =>
        v.remotes.flatMap(r => {
          const tag = r.pool?.trim();
          return tag ? [{ remote: r.name, tag }] : [];
        })
      ),
      remotes: external.versions.flatMap(v => v.remotes.map(r => r.name)),
      value: { name, external },
    })
  );
  return groupByMembership(candidates, log);
}
