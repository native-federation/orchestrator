import type { ExternalName, RemoteName, VersionName } from 'lib/core/1.domain';
import type { Coverage, FamilyInstance, PoolMember, Specifier } from './pool.types';

// What a runtime remote is checked against before it may take a committed build: coverage and its own
// ranges, never tag distance.

/** `remote -> member -> every tag that remote's own `requiredVersion` accepts.` */
export type Acceptance = Map<RemoteName, Map<ExternalName, Set<VersionName>>>;

/**
 * Every tag each remote's own range accepts, per member. Precomputed rather than asked per
 * consumer/candidate pair, and `isCompatible` is expected to be `determine`'s memoized one — this must
 * never replicate its O(versions²) search.
 */
export function acceptanceTable(
  members: PoolMember[],
  isCompatible: (tag: VersionName, range: string) => boolean
): Acceptance {
  const table: Acceptance = new Map();

  for (const member of members) {
    const tags: VersionName[] = [];
    for (const version of member.external.versions) tags.push(version.tag);

    for (const version of member.external.versions) {
      for (const meta of version.remotes) {
        let byMember = table.get(meta.name);
        if (!byMember) table.set(meta.name, (byMember = new Map()));
        if (byMember.has(member.name)) continue;

        const accepted = new Set<VersionName>();
        for (let t = 0; t < tags.length; t++) {
          if (isCompatible(tags[t]!, meta.requiredVersion)) accepted.add(tags[t]!);
        }
        byMember.set(member.name, accepted);
      }
    }
  }

  return table;
}

export function covers(coverage: Coverage, consumed: Iterable<Specifier>): boolean {
  for (const specifier of consumed) if (!coverage.has(specifier)) return false;
  return true;
}

export function acceptsAll(
  acceptance: Acceptance,
  build: FamilyInstance,
  consumer: RemoteName,
  consumed: readonly ExternalName[]
): boolean {
  const byMember = acceptance.get(consumer);
  if (!byMember) return false;

  for (let i = 0; i < consumed.length; i++) {
    const offered = build.get(consumed[i]!);
    if (offered === undefined) return false;
    if (!byMember.get(consumed[i]!)?.has(offered)) return false;
  }

  return true;
}
