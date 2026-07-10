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

// Namespaced node keys, NUL-separated so no kind or `(remote, tag)` pair can alias another. A
// per-`(remote, tag)` node makes explicit tags remote-local (merge only via a shared member); a
// per-scope node makes auto-pooling global (safe: the scope is machine-derived).
const extNode = (name: ExternalName): string => `ext\x00${name}`;
const tagNode = (remote: string, tag: string): string => `tag\x00${remote}\x00${tag}`;
const scopeNode = (scope: string): string => `scope\x00${scope}`;

export type PoolEdge = { remote: string; tag: string };

// A poolable external's edges: `scope` (auto-pooling, global) and any declared `tags` (remote-local).
// `value` is the payload returned per member — a `SharedExternal` for init, a package name for dynamic.
export type PoolCandidate<T> = {
  name: ExternalName;
  scope?: string;
  tags: readonly PoolEdge[];
  value: T;
};

// npm scope of a package when auto-pooling is on (`@framework/core` -> `framework`); undefined for
// unscoped names or when auto-pooling is off.
export function autoScope(name: string, useAutoExternalPooling: boolean): string | undefined {
  return useAutoExternalPooling ? SCOPED_PACKAGE.exec(name)?.[1] : undefined;
}

/**
 * Group one shareScope's candidates into pools by shared membership: pool = connected component of a
 * graph with edges from auto-pooling (`external -> scope`, global) and declared tags
 * (`external -> tag@remote`, remote-local). See docs/version-resolver.md + plan.md. Returns only real
 * pools (>=2 members), keyed by and iterated in order of their canonical name (smallest member —
 * reload-stable). An explicit-tag member that pooled with nothing is warned (likely typo or missing
 * sibling); auto-scope singletons stay silent.
 */
export function groupByMembership<T>(
  candidates: readonly PoolCandidate<T>[],
  log?: LogHandler
): Map<PoolName, T[]> {
  const dsu = createDSU();
  const tagged = new Set<ExternalName>();
  const poolable: { name: ExternalName; value: T }[] = [];

  for (const candidate of candidates) {
    let joined = false;
    if (candidate.scope !== undefined) {
      dsu.union(extNode(candidate.name), scopeNode(candidate.scope));
      joined = true;
    }
    for (const edge of candidate.tags) {
      dsu.union(extNode(candidate.name), tagNode(edge.remote, edge.tag));
      tagged.add(candidate.name);
      joined = true;
    }
    if (joined) poolable.push({ name: candidate.name, value: candidate.value });
  }

  const byComponent = new Map<number, { name: ExternalName; value: T }[]>();
  for (const entry of poolable) {
    const root = dsu.component(extNode(entry.name));
    (byComponent.get(root) ?? byComponent.set(root, []).get(root)!).push(entry);
  }

  const pools: { name: ExternalName; value: T }[][] = [];
  for (const members of byComponent.values()) {
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
      value: { name, external },
    })
  );
  return groupByMembership(candidates, log);
}
