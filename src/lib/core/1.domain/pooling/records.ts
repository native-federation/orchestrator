import type { DeepReadonly } from 'lib/utils/deep-readonly';
import type {
  ExternalName,
  PoolCause,
  RemoteName,
  SharedExternal,
  SharedVersion,
  SharedVersionMeta,
  shareScope,
  VersionName,
} from 'lib/core/1.domain';
import { addRemoteToVersion } from 'lib/core/1.domain/externals/basis';
import { byTag, mergeRows, rowAt } from 'lib/core/1.domain/externals/rows';
import type { Election } from './election';
import type { PoolMember, PoolName } from './membership';

export type PlacedPool = Election & { poolName: PoolName };

// One row per (tag, action); see docs/version-resolver.md §"How the verdicts land in the record and the map".
export function memberRecord(
  member: PoolMember,
  pool: PlacedPool,
  compare: (a: VersionName, b: VersionName) => number
): SharedExternal {
  const { globalTags, placements } = pool;
  // A package can ship only secondary entrypoints (`material/table` without `material`), so its shared tag
  // is whatever round 1 serves any of its entrypoints at.
  let sharedTag: VersionName | undefined;
  for (const version of member.external.versions)
    for (const meta of version.remotes)
      for (const s in meta.entries) sharedTag ??= globalTags.get(s);

  const claimsGlobally = (name: RemoteName) => placements.get(name)!.kind === 'global';

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
      const { servedBy: _servedBy, poolCause: _poolCause, ...rest } = stored;
      // The import map is rebuilt from scratch, so it re-marks what it publishes.
      const meta = { ...rest, cached: false };
      const placement = placements.get(meta.name)!;
      if (placement.kind === 'global')
        place(version.tag, version.tag === sharedTag ? 'share' : 'skip', meta);
      else if (placement.kind === 'subpool')
        place(version.tag, 'skip', { ...meta, servedBy: placement.owner });
      else place(version.tag, 'scope', { ...meta, poolCause: placement.cause });
    }

  const rows = mergeRows(placed, winnerRow);
  // Stable, so the winner still leads; the import map publishes the first copy listing a specifier.
  for (const row of rows)
    row.remotes.sort((a, b) => Number(!claimsGlobally(a.name)) - Number(!claimsGlobally(b.name)));

  const order = { share: 0, skip: 1, scope: 2 };
  const newest = byTag(compare);
  const versions = rows.sort((a, b) => newest(a, b) || order[a.action] - order[b.action]);

  return { dirty: false, poolName: pool.poolName, versions };
}

export type CopyMove = { cause: PoolCause } | { fromMap: true };

// A fresh record, only the loaded remote's copy moved.
export function movedRecord(
  external: SharedExternal,
  remote: RemoteName,
  move: CopyMove,
  compare: (a: VersionName, b: VersionName) => number
): SharedExternal {
  return withoutStaleServingBuild(moveCopy(external, remote, move, compare));
}

// The claim table trusts `servingBuild`, so a move that takes the named copy out of every share row drops it.
function withoutStaleServingBuild(record: SharedExternal): SharedExternal {
  const { servingBuild, ...rest } = record;
  if (servingBuild === undefined) return record;
  const shares = record.versions.some(
    v => v.action === 'share' && v.remotes.some(r => r.name === servingBuild)
  );
  return shares ? record : rest;
}

function moveCopy(
  external: SharedExternal,
  remote: RemoteName,
  move: CopyMove,
  compare: (a: VersionName, b: VersionName) => number
): SharedExternal {
  if ('fromMap' in move) return recordFromMap(external, remote);

  const moved: { tag: string; meta: SharedVersionMeta }[] = [];
  const versions = external.versions
    .map(v => {
      const copy = v.remotes.find(r => r.name === remote);
      if (!copy) return v;
      const { servedBy: _servedBy, ...rest } = copy;
      const meta = { ...rest, cached: true, poolCause: move.cause };
      if (v.action === 'scope')
        return { ...v, remotes: v.remotes.map(r => (r === copy ? meta : r)) };
      moved.push({ tag: v.tag, meta });
      return { ...v, remotes: v.remotes.filter(r => r !== copy) };
    })
    // A version only the loaded remote held — a `share` it introduced — leaves with it.
    .filter(v => v.remotes.length > 0);

  for (const { tag, meta } of moved) {
    const scoped = rowAt(versions, tag, 'scope');
    if (!scoped) versions.push({ tag, action: 'scope', host: false, remotes: [meta] });
    else versions[versions.indexOf(scoped)] = { ...scoped, remotes: [...scoped.remotes, meta] };
  }

  return { ...external, versions: versions.sort(byTag(compare)) };
}

// A copy that now runs the map's files moves into a skip row at its tag: it publishes nothing. A tag keeps one
// row per action, so it joins a skip row already there.
function recordFromMap(external: SharedExternal, remote: RemoteName): SharedExternal {
  // The copy sits alone in the share row it opened, among other islands in a scope row, or in a share row it
  // joined at the same tag, whose other copies stay.
  const opened = external.versions.find(
    v => v.action !== 'skip' && v.remotes.some(r => r.name === remote)
  )!;
  const meta = { ...opened.remotes.find(r => r.name === remote)!, cached: false };
  const joined = rowAt(external.versions, opened.tag, 'skip');
  const into = joined
    ? { ...joined, remotes: [...joined.remotes] }
    : { ...opened, action: 'skip' as const, remotes: [] };
  addRemoteToVersion(into, meta);

  const versions = external.versions.flatMap(v => {
    if (v === joined) return [into];
    if (v !== opened) return [v];
    const left = { ...v, remotes: v.remotes.filter(r => r.name !== remote) };
    return [...(left.remotes.length > 0 ? [left] : []), ...(joined ? [] : [into])];
  });
  return { ...external, versions };
}

export function withoutPoolResults(external: DeepReadonly<SharedExternal>): SharedExternal {
  const { poolName: _poolName, poolWinner: _poolWinner, ...rest } = external;
  return {
    ...rest,
    versions: external.versions.map(v => ({
      ...v,
      remotes: v.remotes.map(({ servedBy: _servedBy, poolCause: _poolCause, ...meta }) => meta),
    })),
  };
}

// Pool results are kept: a pool nobody re-elected can still be renamed by another. An external in no pool
// keeps its stored name until the next dirty init strips it.
export function renamedRecords(
  scope: shareScope,
  pools: ReadonlyMap<PoolName, readonly PoolMember[]>
): [ExternalName, SharedExternal][] {
  const renamed: [ExternalName, SharedExternal][] = [];
  for (const [poolName, members] of pools)
    for (const { name } of members)
      if (scope[name]!.poolName !== poolName) renamed.push([name, { ...scope[name]!, poolName }]);
  return renamed;
}
