import type {
  RemoteName,
  SharedExternal,
  SharedVersion,
  SharedVersionMeta,
  VersionName,
} from 'lib/core/1.domain';
import { byTag, mergeRows } from 'lib/core/1.domain/externals/rows';
import type { Specifier } from 'lib/core/1.domain/externals/specifier';
import type { Election } from './election';
import type { PoolMember, PoolName } from './membership';

// The records that follow from where each remote of one pool runs; pure, the step writes them.
// See docs/version-resolver.md §"How the verdicts land in the record and the map".

// Everything `memberRecord` reads of one pool.
export type PlacedPool = Election & {
  poolName: PoolName;
  compare: (a: VersionName, b: VersionName) => number;
};

// One member's record, one row per `(tag, action)`; see docs/version-resolver.md §"How the verdicts land in
// the record and the map".
export function memberRecord(member: PoolMember, pool: PlacedPool): SharedExternal {
  const { globalTags, placements } = pool;
  // A package can ship only secondary entrypoints (`material/table` without `material`), so its shared tag
  // is whatever round 1 serves any of its entrypoints at.
  // An entrypoint round 1 does not serve itself still has its package's tag, which is what rule 5 compares.
  let sharedTag: VersionName | undefined;
  let pinned = false;
  for (const version of member.external.versions)
    for (const meta of version.remotes)
      for (const s in meta.entries) {
        sharedTag ??= globalTags.get(s);
        pinned ||= globalTags.tagOf(s) !== undefined;
      }

  const runsOn = (name: RemoteName) => {
    const placement = placements.get(name)!;
    return placement.kind === 'subpool' ? placement.build : name;
  };
  const claimsGlobally = (name: RemoteName) =>
    placements.get(name)!.kind === 'global' || pool.publishers.has(runsOn(name));
  // What those copies of this member ship, per tag. The import map maps a specifier from whichever external
  // reaches it first, so a publisher in another member's record cannot stop a copy of this one claiming it.
  const claimableAt = new Map<VersionName, Set<Specifier>>();
  for (const version of member.external.versions)
    for (const { name, entries } of version.remotes)
      if (claimsGlobally(name)) {
        let specifiers = claimableAt.get(version.tag);
        if (!specifiers) claimableAt.set(version.tag, (specifiers = new Set()));
        for (const s in entries) specifiers.add(s);
      }

  // Rule 5: a build agreeing with round 1 takes its files wherever round 1 publishes this package; one that
  // serves some member itself only where a claiming copy at its tag lists every file it takes.
  const takesGlobalFiles = (meta: SharedVersionMeta, tag: VersionName) => {
    const runs = runsOn(meta.name);
    return (
      pool.agreeing.has(runs) &&
      pinned &&
      (pool.publishers.has(runs) ||
        Object.keys(meta.entries).every(
          s => globalTags.get(s) === tag && claimableAt.get(tag)?.has(s) === true
        ))
    );
  };

  const placed: SharedVersion[] = [];
  let winnerRow: SharedVersion | undefined;
  const place = (tag: VersionName, action: SharedVersion['action'], meta: SharedVersionMeta) => {
    const row = { tag, host: false, action, remotes: [meta] };
    placed.push(row);
    if (meta.name !== pool.winner) return;
    // The winner's copy leads its row: `remotes[0]` is the basis the global map publishes.
    winnerRow = row;
    row.host = pool.winnerIsHost;
  };

  for (const version of member.external.versions)
    for (const stored of version.remotes) {
      const { servedBy: _servedBy, poolCause: _poolCause, ...meta } = stored;
      const placement = placements.get(meta.name)!;
      if (placement.kind === 'global' || takesGlobalFiles(meta, version.tag))
        place(version.tag, version.tag === sharedTag ? 'share' : 'skip', meta);
      else if (placement.kind === 'subpool')
        place(version.tag, 'skip', { ...meta, servedBy: placement.build });
      else place(version.tag, 'scope', { ...meta, poolCause: placement.cause });
    }

  const rows = mergeRows(placed, winnerRow);
  // Stable, so the winner still leads; the import map publishes the first copy listing a specifier.
  for (const row of rows)
    row.remotes.sort((a, b) => Number(!claimsGlobally(a.name)) - Number(!claimsGlobally(b.name)));

  // Within a tag `share`, `skip`, then `scope`.
  const order = { share: 0, skip: 1, scope: 2 };
  const newest = byTag(pool.compare);
  const versions = rows.sort((a, b) => newest(a, b) || order[a.action] - order[b.action]);

  return { dirty: false, poolName: pool.poolName, versions };
}

// A member that joined since carries no winner yet; only two stored winners that conflict void it.
export function previousWinner(members: PoolMember[]): RemoteName | undefined {
  const winners = new Set(members.flatMap(m => m.external.poolWinner ?? []));
  const [winner] = winners;
  if (winners.size !== 1) return undefined;
  const ships = members.some(m =>
    m.external.versions.some(v => v.remotes.some(r => r.name === winner))
  );
  return ships ? winner : undefined;
}
