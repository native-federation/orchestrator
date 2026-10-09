import type { ExternalName, SharedExternal, shareScope } from 'lib/core/1.domain';
import { owningPackage } from 'lib/core/1.domain/externals/specifier';
import { compareStrings } from 'lib/utils/compare-strings';

// Unique per share scope: the most-declared of the labels merged into the pool.
export type PoolName = string;

export type PoolMember = {
  name: ExternalName;
  external: SharedExternal;
};

export type Pools<T> = {
  pools: Map<PoolName, T[]>;
  // Labelled externals that pooled with nothing, in graph order: likely a typo or a missing sibling.
  labelledAlone: ExternalName[];
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

// A label is one node across every remote: the label is the pool's identity.
// NUL-separated so a label can never alias an external.
const extNode = (name: ExternalName): string => `ext\x00${name}`;
const labelNode = (label: string): string => `label\x00${label}`;

// `labels` holds one entry per declaring copy, which `mostDeclaredLabel` counts.
export type PoolCandidate<T> = {
  name: ExternalName;
  labels: readonly string[];
  value: T;
};

// A pool is a connected component of `external -> label` edges (one per declared label, whichever remote
// declared it) and `entrypoint -> package` edges; only pools of >=2 members are returned. See
// docs/version-resolver.md.
export function groupByMembership<T>(candidates: readonly PoolCandidate<T>[]): Pools<T> {
  const dsu = createDSU();
  const labelled = new Set<ExternalName>();

  for (const candidate of candidates) {
    for (const label of candidate.labels) {
      dsu.union(extNode(candidate.name), labelNode(label));
      labelled.add(candidate.name);
    }
  }

  // An entrypoint follows its package into whatever pool the package joins, labelled or not: a flat build
  // that labels only the package would otherwise leave its entrypoints out — measured as a torn package.
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
  const labelledAlone: ExternalName[] = [];
  for (const members of byComponent.values()) {
    // A property of the component, not of one member: an entrypoint carries no label of its own yet pools
    // with the package that does.
    if (!members.some(m => labelled.has(m.name))) continue;

    members.sort((a, b) => compareStrings(a.name, b.name));
    if (members.length < 2) {
      const only = members[0]!;
      if (labelled.has(only.name)) labelledAlone.push(only.name);
      continue;
    }
    pools.push(members);
  }

  // Pools come back in order of their smallest member; the election's determinism relies on it.
  pools.sort((a, b) => compareStrings(a[0]!.name, b[0]!.name));

  // Unique without suffixing: a label belongs to exactly one component, so two pools never pick the same one.
  const named = new Map<PoolName, T[]>();
  for (const members of pools)
    named.set(
      mostDeclaredLabel(members) ?? members[0]!.name,
      members.map(m => m.value)
    );
  return { pools: named, labelledAlone };
}

function mostDeclaredLabel(members: readonly PoolCandidate<unknown>[]): string | undefined {
  const counts = new Map<string, number>();
  for (const member of members)
    for (const label of member.labels) counts.set(label, (counts.get(label) ?? 0) + 1);

  let best: string | undefined;
  for (const [label, count] of counts) {
    const top = best === undefined ? 0 : counts.get(best)!;
    if (count > top || (count === top && compareStrings(label, best!) < 0)) best = label;
  }
  return best;
}

export function buildPools(sharedExternals: shareScope): Pools<PoolMember> {
  const candidates = Object.entries(sharedExternals).map<PoolCandidate<PoolMember>>(
    ([name, external]) => ({
      name,
      labels: external.versions.flatMap(v =>
        v.remotes.flatMap(r => {
          const label = r.pool?.trim();
          return label ? [label] : [];
        })
      ),
      value: { name, external },
    })
  );
  return groupByMembership(candidates);
}
