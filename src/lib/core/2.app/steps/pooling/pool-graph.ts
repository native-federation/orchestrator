import type { ExternalName, shareScope } from 'lib/core/1.domain';
import type { LogHandler } from '../../config/log.contract';
import type { PoolMember, PoolName } from './pool.types';

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

// Namespaced node keys, NUL-separated so no kind or `(remote, …)` pair can alias another. Tag nodes are
// per remote, so every edge is remote-local and pools merge only through a shared member.
const extNode = (name: ExternalName): string => `ext\x00${name}`;
const tagNode = (remote: string, tag: string): string => `tag\x00${remote}\x00${tag}`;

export type PoolEdge = { remote: string; tag: string };

// A poolable external's declared `tags`. `value` is the payload returned per member.
export type PoolCandidate<T> = {
  name: ExternalName;
  tags: readonly PoolEdge[];
  value: T;
};

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
 * graph whose edges are all remote-local — `external -> tag@remote` for each declared tag — plus an
 * unconditional `entrypoint -> package` edge. See docs/version-resolver.md.
 *
 * Returns only real pools (>=2 members), keyed by `poolName` and iterated in order of their smallest
 * member, which is what keeps the names reload-stable. A tagged member that pooled with nothing is warned
 * (likely typo or missing sibling).
 */
export function groupByMembership<T>(
  candidates: readonly PoolCandidate<T>[],
  log?: LogHandler
): Map<PoolName, T[]> {
  const dsu = createDSU();
  const tagged = new Set<ExternalName>();

  for (const candidate of candidates) {
    for (const edge of candidate.tags) {
      dsu.union(extNode(candidate.name), tagNode(edge.remote, edge.tag));
      tagged.add(candidate.name);
    }
  }

  // An entrypoint follows its package into whatever pool the package joins, tagged or not: a flat build
  // that tags only the package would otherwise leave its entrypoints out — measured as a torn package.
  const declared = new Set(candidates.map(c => c.name));
  for (const candidate of candidates) {
    const owner = owningPackage(candidate.name);
    if (owner !== undefined && declared.has(owner))
      dsu.union(extNode(candidate.name), extNode(owner));
  }

  const byComponent = new Map<number, PoolCandidate<T>[]>();
  for (const candidate of candidates) {
    const root = dsu.component(extNode(candidate.name));
    const members = byComponent.get(root) ?? byComponent.set(root, []).get(root)!;
    members.push(candidate);
  }

  const pools: PoolCandidate<T>[][] = [];
  for (const members of byComponent.values()) {
    // A property of the component, not of one member: an entrypoint carries no tag of its own yet pools
    // with the package that does.
    if (!members.some(m => tagged.has(m.name))) continue;

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

  const named = new Map<PoolName, T[]>();
  for (const members of pools) {
    const label = mostDeclaredTag(members) ?? members[0]!.name;
    let name = label;
    for (let n = 2; named.has(name); n++) name = `${label}~${n}`;
    named.set(
      name,
      members.map(m => m.value)
    );
  }
  return named;
}

// Tags are remote-local, so unrelated pools can share one: `poolName` makes the name unique per scope.
function mostDeclaredTag(members: readonly PoolCandidate<unknown>[]): string | undefined {
  const counts = new Map<string, number>();
  for (const member of members)
    for (const edge of member.tags) counts.set(edge.tag, (counts.get(edge.tag) ?? 0) + 1);

  let best: string | undefined;
  for (const [tag, count] of counts) {
    const top = best === undefined ? 0 : counts.get(best)!;
    if (count > top || (count === top && tag.localeCompare(best!) < 0)) best = tag;
  }
  return best;
}

/** Build candidates from the stored shared externals of one shareScope. */
export function buildPools(
  sharedExternals: shareScope,
  log?: LogHandler
): Map<PoolName, PoolMember[]> {
  const candidates = Object.entries(sharedExternals).map<PoolCandidate<PoolMember>>(
    ([name, external]) => ({
      name,
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
