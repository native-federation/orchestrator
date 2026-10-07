import type { ExternalName, SharedExternal, shareScope } from 'lib/core/1.domain';
import { owningPackage } from 'lib/core/1.domain/externals/specifier';
import { compareStrings } from 'lib/utils/compare-strings';

// Unique per share scope: the most-declared of the names merged into the pool.
export type PoolName = string;

export type PoolMember = {
  name: ExternalName;
  external: SharedExternal;
};

export type Pools<T> = {
  pools: Map<PoolName, T[]>;
  // Tagged externals that pooled with nothing, in graph order: likely a typo or a missing sibling.
  lonelyTags: ExternalName[];
};

// Union by size with iterative path halving (no stack growth in the browser); keys interned to array indices.
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

// A name is one node across every remote: the name is the pool's identity.
// NUL-separated so a name can never alias an external.
const extNode = (name: ExternalName): string => `ext\x00${name}`;
const nameNode = (tag: string): string => `name\x00${tag}`;

// `tags` holds one entry per declaring copy, which `mostDeclaredTag` counts.
export type PoolCandidate<T> = {
  name: ExternalName;
  tags: readonly string[];
  value: T;
};

// A pool is a connected component of `external -> name` edges (one per declared tag, whichever remote
// declared it) and `entrypoint -> package` edges; only pools of >=2 members are returned. See
// docs/version-resolver.md.
export function groupByMembership<T>(candidates: readonly PoolCandidate<T>[]): Pools<T> {
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
  const lonelyTags: ExternalName[] = [];
  for (const members of byComponent.values()) {
    // A property of the component, not of one member: an entrypoint carries no tag of its own yet pools
    // with the package that does.
    if (!members.some(m => tagged.has(m.name))) continue;

    members.sort((a, b) => compareStrings(a.name, b.name));
    if (members.length < 2) {
      const only = members[0]!;
      if (tagged.has(only.name)) lonelyTags.push(only.name);
      continue;
    }
    pools.push(members);
  }

  // Pools come back in order of their smallest member; the election's determinism relies on it.
  pools.sort((a, b) => compareStrings(a[0]!.name, b[0]!.name));

  // Unique without suffixing: a name belongs to exactly one component, so two pools never pick the same one.
  const named = new Map<PoolName, T[]>();
  for (const members of pools)
    named.set(
      mostDeclaredTag(members) ?? members[0]!.name,
      members.map(m => m.value)
    );
  return { pools: named, lonelyTags };
}

function mostDeclaredTag(members: readonly PoolCandidate<unknown>[]): string | undefined {
  const counts = new Map<string, number>();
  for (const member of members)
    for (const tag of member.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);

  let best: string | undefined;
  for (const [tag, count] of counts) {
    const top = best === undefined ? 0 : counts.get(best)!;
    if (count > top || (count === top && compareStrings(tag, best!) < 0)) best = tag;
  }
  return best;
}

export function buildPools(sharedExternals: shareScope): Pools<PoolMember> {
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
  return groupByMembership(candidates);
}
