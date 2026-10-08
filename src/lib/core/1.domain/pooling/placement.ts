import type {
  ExternalName,
  PoolCause,
  RemoteName,
  SharedExternal,
  SharedVersion,
  SharedVersionMeta,
  VersionName,
} from 'lib/core/1.domain';
import { byTag, mergeRows } from 'lib/core/1.domain/externals/rows';
import { type Specifier, SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import { buildOf, copiesByRemote } from './builds';
import type { Election } from './election';
import type { PoolMember, PoolName } from './membership';
import { hostRemotes } from './views';

// Where each remote of one pool runs and the records that follows from it; pure, the step logs and writes.
// See docs/version-resolver.md §"How the verdicts land in the record and the map".

// Why a remote missed round 1. `with`: the specifiers no build shipped together with `gap`, for a remote the
// map serves but no build witnesses.
export type PoolMiss =
  | { cause: 'incompatible'; member: ExternalName; tag: VersionName; strict: boolean }
  | { cause: 'uncovered'; gap: Specifier; with?: Specifier[] };

// A subpool's build runs its own build too.
export type Placement =
  { kind: 'global' } | { kind: 'runs'; build: RemoteName } | { kind: 'self'; cause: PoolCause };

// Everything `memberRecord` reads of one pool, built once per pool.
export type PlacedPool = {
  poolName: PoolName;
  // Round 1's build; undefined only for a pool with no copies.
  winner?: RemoteName;
  hosts: ReadonlySet<RemoteName>;
  coverage: SpecifierTags;
  agreeing: ReadonlySet<RemoteName>;
  publishers: ReadonlySet<RemoteName>;
  placements: ReadonlyMap<RemoteName, Placement>;
  compare: (a: VersionName, b: VersionName) => number;
};

// Every remote off the global map, in placement order; undefined for a subpool's build the global map would
// serve.
export function missesOf(election: Election): Map<RemoteName, PoolMiss | undefined> {
  const misses = new Map<RemoteName, PoolMiss | undefined>();
  const remotes = [...election.subpools.flatMap(p => p.members), ...election.alone];
  for (const remote of remotes) {
    const miss = election.missOf(remote);
    misses.set(
      remote,
      miss === undefined
        ? undefined
        : 'rejected' in miss
          ? { cause: 'incompatible', ...miss.rejected }
          : 'unwitnessed' in miss
            ? { cause: 'uncovered', ...miss.unwitnessed }
            : { cause: 'uncovered', gap: miss.gap }
    );
  }
  return misses;
}

export function electedPlacement(
  poolName: PoolName,
  election: Election,
  misses: ReadonlyMap<RemoteName, PoolMiss | undefined>,
  hosts: ReadonlySet<RemoteName>,
  compare: PlacedPool['compare']
): PlacedPool {
  const placements = new Map<RemoteName, Placement>();
  for (const remote of election.global) placements.set(remote, { kind: 'global' });
  for (const { build, members } of election.subpools)
    for (const remote of members) placements.set(remote, { kind: 'runs', build });
  for (const remote of election.alone)
    placements.set(remote, { kind: 'self', cause: misses.get(remote)!.cause });
  return {
    poolName,
    winner: election.winner,
    hosts,
    coverage: election.coverage,
    agreeing: election.agreeing,
    publishers: election.publishers,
    placements,
    compare,
  };
}

// The placement that cannot tear, for a pool that could not be elected: the host's build, else the first
// arrival's, stays global and every other remote serves its whole family itself.
export function safePlacement(
  poolName: PoolName,
  members: PoolMember[],
  compare: PlacedPool['compare']
): PlacedPool {
  const hosts = hostRemotes(members);
  // In arrival order, as `arrivalOrder` reads it.
  const shipped = copiesByRemote(members);
  const remotes = [...shipped.keys()];
  const winner = remotes.find(r => hosts.has(r)) ?? remotes[0];
  const placements = new Map<RemoteName, Placement>(
    remotes.map(r => [r, r === winner ? { kind: 'global' } : { kind: 'self', cause: 'uncovered' }])
  );
  return {
    poolName,
    winner,
    hosts,
    coverage:
      winner === undefined ? new SpecifierTags() : buildOf(winner, shipped.get(winner)!).tags,
    agreeing: new Set(),
    publishers: new Set(),
    placements,
    compare,
  };
}

// One member's record, one row per `(tag, action)`; see docs/version-resolver.md §"How the verdicts land in
// the record and the map".
export function memberRecord(member: PoolMember, pool: PlacedPool): SharedExternal {
  const { coverage, placements } = pool;
  // A package can ship only secondary entrypoints (`material/table` without `material`), so its shared tag
  // is whatever round 1 serves any of its entrypoints at.
  // An entrypoint round 1 does not serve itself still has its package's tag, which is what rule 5 compares.
  let sharedTag: VersionName | undefined;
  let pinned = false;
  for (const version of member.external.versions)
    for (const meta of version.remotes)
      for (const s in meta.entries) {
        sharedTag ??= coverage.get(s);
        pinned ||= coverage.tagOf(s) !== undefined;
      }

  const runsOn = (name: RemoteName) => {
    const placement = placements.get(name)!;
    return placement.kind === 'runs' ? placement.build : name;
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
          s => coverage.get(s) === tag && claimableAt.get(tag)?.has(s) === true
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
    row.host = pool.hosts.has(meta.name);
  };

  for (const version of member.external.versions)
    for (const stored of version.remotes) {
      const { servedBy: _servedBy, poolCause: _poolCause, ...meta } = stored;
      const placement = placements.get(meta.name)!;
      if (placement.kind === 'global' || takesGlobalFiles(meta, version.tag))
        place(version.tag, version.tag === sharedTag ? 'share' : 'skip', meta);
      else if (placement.kind === 'runs')
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
