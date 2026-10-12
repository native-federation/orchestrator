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
import { packageOf, type Specifier } from 'lib/core/1.domain/externals/specifier';
import type { IsChunked } from './builds';
import { tearsPackage } from './rules';
import type { Election } from './election';
import type { PoolMember, PoolName } from './membership';

export type PlacedPool = Omit<Election, 'agreeing'> & {
  poolName: PoolName;
  // The builds, among those agreeing with round 1, whose remotes take its files where their versions match.
  keepsGlobalFiles: ReadonlySet<RemoteName>;
};

// Rule 5 holds per group on one build (a subpool, or a self-serving remote), so its members bind each other
// on one build. See docs/version-resolver.md §"How the verdicts land in the record and the map".
export function placePool(
  election: Election,
  poolName: PoolName,
  members: readonly PoolMember[],
  isChunked: IsChunked
): PlacedPool {
  const { agreeing, globalTags, placements, ...placed } = election;
  const servedPackages = new Set([...globalTags.keys()].map(packageOf));
  // A copy off the map beside a specifier the map serves runs a second instance of it.
  const tears = (meta: SharedVersionMeta) => {
    const chunked = isChunked(meta.name, meta.bundle);
    return Object.keys(meta.entries).some(
      s => globalTags.has(s) || tearsPackage(chunked, s, servedPackages)
    );
  };
  const keepsGlobalFiles = new Set(agreeing);
  for (const member of members) {
    const takesGlobalFiles = globalFilesTaker(member, { globalTags, placements }, agreeing);
    for (const version of member.external.versions)
      for (const meta of version.remotes) {
        const runs = runsOn(placements, meta.name);
        if (keepsGlobalFiles.has(runs) && !takesGlobalFiles(meta, version.tag) && tears(meta))
          keepsGlobalFiles.delete(runs);
      }
  }
  return { ...placed, globalTags, placements, poolName, keepsGlobalFiles };
}

const runsOn = (placements: Election['placements'], name: RemoteName) => {
  const placement = placements.get(name)!;
  return placement.kind === 'subpool' ? placement.owner : name;
};

// Rule 5: a build that keeps the global files takes them where a global copy at its tag lists every file it
// takes.
function globalFilesTaker(
  member: PoolMember,
  { globalTags, placements }: Pick<Election, 'globalTags' | 'placements'>,
  keepsGlobalFiles: ReadonlySet<RemoteName>
) {
  // What the global copies of this member ship, per tag. The import map maps a specifier from whichever
  // external reaches it first, so a global copy in another member's record cannot stop a copy of this one
  // claiming it.
  const claimableAt = new Map<VersionName, Set<Specifier>>();
  for (const version of member.external.versions)
    for (const { name, entries } of version.remotes)
      if (placements.get(name)!.kind === 'global') {
        let specifiers = claimableAt.get(version.tag);
        if (!specifiers) claimableAt.set(version.tag, (specifiers = new Set()));
        for (const s in entries) specifiers.add(s);
      }

  return (meta: SharedVersionMeta, tag: VersionName) =>
    keepsGlobalFiles.has(runsOn(placements, meta.name)) &&
    Object.keys(meta.entries).every(
      s => globalTags.get(s) === tag && claimableAt.get(tag)?.has(s) === true
    );
}

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
  const takesGlobalFiles = globalFilesTaker(member, pool, pool.keepsGlobalFiles);

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
