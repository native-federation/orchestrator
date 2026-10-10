import type { ExternalName, SharedExternal, shareScope } from 'lib/core/1.domain';
import { owningPackage } from 'lib/core/1.domain/externals/specifier';
import type { DeepReadonly } from 'lib/utils/deep-readonly';
import { compareStrings } from 'lib/utils/compare-strings';

// Unique per share scope: the most-declared of the labels merged into the pool.
export type PoolName = string;

export type PoolMember = {
  name: ExternalName;
  external: DeepReadonly<SharedExternal>;
};

export type Membership = {
  pools: Map<PoolName, PoolMember[]>;
  // Labelled externals that pooled with nothing, in scope order: likely a typo or a missing sibling.
  labelledAlone: ExternalName[];
};

// Iterative path halving: no stack growth in the browser.
function unionFind() {
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    for (let up = parent.get(node); up !== undefined; up = parent.get(node)) {
      const grand = parent.get(up);
      if (grand === undefined) return up;
      parent.set(node, grand);
      node = grand;
    }
    return node;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  return { find, union };
}

// A label is one node across every remote: the label is the pool's identity.
// NUL-separated so a label can never alias an external.
const extNode = (name: ExternalName): string => `ext\x00${name}`;
const labelNode = (label: string): string => `label\x00${label}`;

// A pool is a connected component of `external -> label` edges (one per declared label, whichever remote
// declared it) and `entrypoint -> package` edges; only pools of >=2 members are returned. See
// docs/version-resolver.md.
export function buildPools(sharedExternals: DeepReadonly<shareScope>): Membership {
  const { find, union } = unionFind();
  // One entry per declaring copy, which `mostDeclaredLabel` counts.
  const labelsOf = new Map<ExternalName, string[]>();

  for (const [name, external] of Object.entries(sharedExternals)) {
    const labels = external.versions.flatMap(v =>
      v.remotes.flatMap(r => {
        const label = r.pool?.trim();
        return label ? [label] : [];
      })
    );
    labelsOf.set(name, labels);
    for (const label of labels) union(extNode(name), labelNode(label));
  }

  // An entrypoint follows its package into whatever pool the package joins, labelled or not: a flat build
  // that labels only the package would otherwise leave its entrypoints out — measured as a torn package.
  for (const name of labelsOf.keys()) {
    const owner = owningPackage(name);
    if (owner !== undefined && labelsOf.has(owner)) union(extNode(name), extNode(owner));
  }

  const byComponent = new Map<string, PoolMember[]>();
  for (const [name, external] of Object.entries(sharedExternals)) {
    const root = find(extNode(name));
    const members = byComponent.get(root) ?? byComponent.set(root, []).get(root)!;
    members.push({ name, external });
  }

  // Unique without suffixing: a label belongs to exactly one component, so two pools never pick the same one.
  const pools = new Map<PoolName, PoolMember[]>();
  const labelledAlone: ExternalName[] = [];
  for (const members of byComponent.values()) {
    // A property of the component, not of one member: an entrypoint carries no label of its own yet pools
    // with the package that does.
    if (!members.some(m => labelsOf.get(m.name)!.length > 0)) continue;

    if (members.length < 2) labelledAlone.push(members[0]!.name);
    else
      pools.set(
        mostDeclaredLabel(members, labelsOf),
        members.sort((a, b) => compareStrings(a.name, b.name))
      );
  }
  return { pools, labelledAlone };
}

function mostDeclaredLabel(
  members: readonly PoolMember[],
  labelsOf: ReadonlyMap<ExternalName, readonly string[]>
): string {
  const counts = new Map<string, number>();
  for (const member of members)
    for (const label of labelsOf.get(member.name)!) counts.set(label, (counts.get(label) ?? 0) + 1);

  let best = '';
  let top = 0;
  for (const [label, count] of counts)
    if (count > top || (count === top && compareStrings(label, best) < 0))
      [best, top] = [label, count];
  return best;
}
