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

// Namespaced node keys, NUL-separated so a name can never alias an external. A name is one node across every
// remote: the name is the pool's identity, and names that share an external are one pool.
const extNode = (name: ExternalName): string => `ext\x00${name}`;
const nameNode = (tag: string): string => `name\x00${tag}`;

// A poolable external's declared `tags`, one per declaring copy. `value` is the payload returned per member.
export type PoolCandidate<T> = {
  name: ExternalName;
  tags: readonly string[];
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
 * Group one shareScope's candidates into pools by name: pool = connected component of a graph with an
 * `external -> name` edge per declared tag, whichever remote declared it, plus an unconditional
 * `entrypoint -> package` edge. See docs/version-resolver.md.
 *
 * Returns only real pools (>=2 members), keyed by `poolName` and iterated in order of their smallest
 * member. A tagged member that pooled with nothing is warned (likely typo or missing sibling).
 */
export function groupByMembership<T>(
  candidates: readonly PoolCandidate<T>[],
  log?: LogHandler
): Map<PoolName, T[]> {
  const dsu = createDSU();
  const tagged = new Set<ExternalName>();

  for (const candidate of candidates) {
    for (const tag of candidate.tags) {
      dsu.union(extNode(candidate.name), nameNode(tag));
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

  // Unique without suffixing: a name belongs to exactly one component, so two pools never pick the same one.
  const named = new Map<PoolName, T[]>();
  for (const members of pools)
    named.set(
      mostDeclaredTag(members) ?? members[0]!.name,
      members.map(m => m.value)
    );
  return named;
}

// A pool merged from several names is named after the one most copies declare.
function mostDeclaredTag(members: readonly PoolCandidate<unknown>[]): string | undefined {
  const counts = new Map<string, number>();
  for (const member of members)
    for (const tag of member.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);

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
          return tag ? [tag] : [];
        })
      ),
      value: { name, external },
    })
  );
  return groupByMembership(candidates, log);
}
