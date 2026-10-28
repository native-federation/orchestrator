import type { DeepReadonly } from 'lib/utils/deep-readonly';
import { compareStrings } from 'lib/utils/compare-strings';
import type { RemoteName } from '../remote/remote-info.contract';
import type { AcceptsTag } from './compatibility';
import type { ExternalName, SharedExternal, shareScope } from './external.contract';
import { mergeRows, redirectRow, rowAt, scopeRemotes } from './rows';
import { groupByPackage, packageOfIn, type Specifier } from './specifier';
import type { SharedVersion, SharedVersionMeta, VersionName } from './version.contract';

export type ServingBuild = { remote: RemoteName; tag: VersionName };

export type ServingCandidate = ServingBuild & {
  host: boolean;
  downloads: number;
  fallbacks: number;
  rootBasis: boolean;
};

export type PackageExternals = readonly (readonly [ExternalName, DeepReadonly<SharedExternal>])[];
type Row = DeepReadonly<SharedVersion>;
type Placed = { row: Row; copy: DeepReadonly<SharedVersionMeta> };

export const byServingRank = (a: ServingCandidate, b: ServingCandidate): number =>
  Number(b.host) - Number(a.host) ||
  a.downloads - b.downloads ||
  a.fallbacks - b.fallbacks ||
  Number(b.rootBasis) - Number(a.rootBasis) ||
  compareStrings(a.remote, b.remote);

export const packagesOf = (scope: DeepReadonly<shareScope>): Map<ExternalName, ExternalName[]> =>
  groupByPackage(Object.keys(scope), name => name, packageOfIn(scope));

export const isPooled = (externals: PackageExternals): boolean =>
  externals.some(([, e]) => e.poolName !== undefined);

// `externals` are package `pkg`'s, in record order. A share row of the root fixes the tag its secondaries follow.
export function servingBuildOf(
  pkg: ExternalName,
  externals: PackageExternals,
  accepts: AcceptsTag
): ServingBuild | undefined {
  if (externals.length === 0) return undefined;
  // A dense build names the record of secondaries it does not declare by npm name, without shipping that root.
  const rootRows = shareRows(externals.find(([name]) => name === pkg)?.[1]).filter(row =>
    row.remotes.some(copy => pkg in copy.entries)
  );
  const rows = rootRows.length > 0 ? rootRows : externals.flatMap(([, e]) => shareRows(e));

  // The election already chose the global build; ranking again per package could split a pool.
  if (isPooled(externals)) return pooledBuild(externals, rows);

  const consumers = consumersOf(externals);
  const builds = buildsOf(rows, rootRows, consumers);
  // A host build outranks every other at any cost: only two or more of the builds left need pricing.
  const hosts = builds.filter(b => b.host);
  const field = hosts.length > 0 ? hosts : builds;
  if (field.length <= 1) return field[0] && { remote: field[0].remote, tag: field[0].tag };
  return cheapestBuild(field, costTable(consumers, accepts));
}

function cheapestBuild(
  field: UnpricedBuild[],
  costOf: (build: ServingBuild) => Cost
): ServingBuild {
  let best: ServingCandidate | undefined;
  for (const b of field) {
    const { downloads, fallbacks } = costOf(b);
    const candidate: ServingCandidate = {
      remote: b.remote,
      tag: b.tag,
      host: b.host,
      rootBasis: b.rootBasis,
      downloads,
      fallbacks,
    };
    if (!best || byServingRank(candidate, best) < 0) best = candidate;
  }
  const { remote, tag } = best!;
  return { remote, tag };
}

// The serving build's copies publish even where that external's own election skipped them, so every specifier
// the build ships stays in its surface. Mutates `external` in place.
export function shareServingCopies(external: SharedExternal, serving: ServingBuild): void {
  for (const row of external.versions) {
    const copy = row.remotes.find(c => c.name === serving.remote);
    if (row.action !== 'skip' || !copy || rowAt(external.versions, row.tag, 'share')) continue;
    row.action = 'share';
    // A host leading the row stops being its basis.
    if (row.remotes[0] !== copy) row.host = false;
    row.remotes = [copy, ...row.remotes.filter(c => c !== copy)];
  }
}

export type ServingObjector = { copy: SharedVersionMeta; tag: VersionName };

// Every share row at another tag follows the serving build the way a version follows its winner. Mutates
// `external` in place; `objector` is the first strict copy that keeps its own build instead.
export function followServingBuild(
  external: SharedExternal,
  serving: ServingBuild,
  accepts: AcceptsTag
): { external: SharedExternal; objector?: ServingObjector } {
  let objector: ServingObjector | undefined;
  const rebuilt = external.versions.flatMap(version => {
    if (
      version.action !== 'share' ||
      version.tag === serving.tag ||
      version.remotes[0]!.name === serving.remote
    )
      return [version];
    const rows = redirectRow(version, serving.tag, accepts);
    // A share row redirects into a `scope` row only of copies that reject the tag strictly.
    const scoped = rows.find(row => row.action === 'scope');
    if (scoped && !objector) objector = { copy: scoped.remotes[0]!, tag: scoped.tag };
    return rows;
  });
  external.versions = mergeRows(rebuilt);
  return { external, objector };
}

// A strict copy's range is its own tag, and a tag scope holds that tag only.
const sameTagOnly: AcceptsTag = (offered, ownTag) => offered === ownTag;

// The strict scope shares every tag side by side, so each package at each tag is served on its own.
export const servedScopes = (scope: shareScope, strict: boolean): shareScope[] =>
  strict ? strictTagScopes(scope) : [scope];

// See docs/version-resolver.md §"Entrypoint coverage and tearing". Rows are cloned, but each remote's copy in them is
// the record's own, so the map's `cached` marks reach storage.
function strictTagScopes(scope: shareScope): shareScope[] {
  const tagScopes: shareScope[] = [];
  for (const [pkg, names] of packagesOf(scope)) {
    const byTag = new Map<VersionName, shareScope>();
    for (const name of names)
      for (const row of scope[name]!.versions) {
        let tagScope = byTag.get(row.tag);
        if (!tagScope) byTag.set(row.tag, (tagScope = {}));
        const external = (tagScope[name] ??= { ...scope[name]!, versions: [] });
        external.versions.push({ ...row, remotes: [...row.remotes] });
      }
    for (const [tag, tagScope] of byTag) {
      // A record stored before determine skipped the strict scope can hold a skip row here, whose copy publishes
      // nothing.
      const lead = [tagScope[pkg], ...Object.values(tagScope)]
        .map(external => external && rowAt(external.versions, tag, 'share'))
        .find(row => row !== undefined);
      if (lead) {
        const serving = { remote: lead.remotes[0]!.name, tag };
        for (const external of Object.values(tagScope)) external.servingBuild = serving.remote;
        scopeFallbacks(Object.entries(tagScope), serving, sameTagOnly);
      }
      tagScopes.push(tagScope);
    }
  }
  return tagScopes;
}

function shareRows(external: DeepReadonly<SharedExternal> | undefined): Row[] {
  return external?.versions.filter(v => v.action === 'share') ?? [];
}

// Keyed by tag and remote rather than the first row per remote, so record order never decides.
function buildsOf(
  rows: Row[],
  rootRows: Row[],
  consumers: Map<RemoteName, Placed[]>
): UnpricedBuild[] {
  const candidates = new Map<string, UnpricedBuild>();
  for (const row of rows)
    for (const copy of row.remotes) {
      const key = `${row.tag}|${copy.name}`;
      if (copy.servedBy || candidates.has(key) || shipsTwoTags(consumers.get(copy.name)!)) continue;
      const basis = copy === row.remotes[0];
      candidates.set(key, {
        remote: copy.name,
        tag: row.tag,
        host: basis && row.host,
        rootBasis: basis && rootRows.includes(row),
      });
    }
  return [...candidates.values()];
}

// The pool's winner, where it ships the root (or, without one, any of the package); otherwise the widest copy:
// every share-row copy lies within the one the election published, so the widest ships exactly it.
function pooledBuild(externals: PackageExternals, rows: Row[]): ServingBuild | undefined {
  const winner = externals.find(([, e]) => e.poolWinner !== undefined)?.[1].poolWinner;
  const shipped = rows.flatMap(row =>
    row.remotes.filter(copy => !copy.servedBy).map(copy => ({ remote: copy.name, tag: row.tag }))
  );
  const own = shipped.find(c => c.remote === winner);
  if (own) return own;
  const width = ({ remote, tag }: ServingBuild) =>
    externals.reduce((n, [, e]) => {
      const copy = shareRows(e)
        .find(row => row.tag === tag)
        ?.remotes.find(c => c.name === remote);
      return n + Object.keys(copy?.entries ?? {}).length;
    }, 0);
  return shipped
    .map(c => ({ c, width: width(c) }))
    .sort((a, b) => b.width - a.width || compareStrings(a.c.remote, b.c.remote))[0]?.c;
}

export function consumersOf(externals: PackageExternals): Map<RemoteName, Placed[]> {
  const consumers = new Map<RemoteName, Placed[]>();
  for (const [, external] of externals)
    for (const row of external.versions)
      for (const copy of row.remotes) {
        const placed = consumers.get(copy.name);
        if (placed) placed.push({ row, copy });
        else consumers.set(copy.name, [{ row, copy }]);
      }
  return consumers;
}

type Cost = Pick<ServingCandidate, 'downloads' | 'fallbacks'>;
type UnpricedBuild = Omit<ServingCandidate, keyof Cost>;
// The remotes that fall back and those that download their own build; a cached copy costs nothing.
type Toll = { fallbacks: Set<RemoteName>; downloads: Set<RemoteName> };

// Builds at one tag that ship the same specifiers there cost the same but for their own remote, so each such
// surface is tolled once.
export function costTable(
  consumers: Map<RemoteName, Placed[]>,
  accepts: AcceptsTag
): (build: ServingBuild) => Cost {
  const scanned = new Map<VersionName, { surface: Surface; toll: Toll }[]>();
  const keyed = new Map<string, Toll>();
  const tollFor = (build: ServingBuild, surface: Surface): Toll => {
    let atTag = scanned.get(build.tag);
    if (!atTag) scanned.set(build.tag, (atTag = []));
    const known = atTag.find(t => sameSurface(t.surface, surface));
    if (known) return known.toll;
    if (atTag.length < SCANNED_SURFACES_PER_TAG) {
      const toll = tollOf(consumers, surface, build.tag, accepts);
      atTag.push({ surface, toll });
      return toll;
    }
    const key = [build.tag, ...[...surface].map(([s, tag]) => `${s}@${tag}`).sort()].join('\n');
    let toll = keyed.get(key);
    if (!toll) keyed.set(key, (toll = tollOf(consumers, surface, build.tag, accepts)));
    return toll;
  };
  return build => {
    const surface = surfaceOf(consumers, build);
    const toll = tollFor(build, surface);
    const others = (remotes: Set<RemoteName>) => remotes.size - Number(remotes.has(build.remote));
    // The serving remote never falls back, and downloads its own build unless cached.
    return {
      downloads: others(toll.downloads) + Number(!allCached(consumers.get(build.remote) ?? [])),
      fallbacks: others(toll.fallbacks),
    };
  };
}

function tollOf(
  consumers: Map<RemoteName, Placed[]>,
  surface: Surface,
  tag: VersionName,
  accepts: AcceptsTag
): Toll {
  const toll: Toll = { fallbacks: new Set(), downloads: new Set() };
  for (const [remote, placed] of consumers) {
    const fallback = fallsBack(placed, surface, tag, accepts);
    if (fallback) toll.fallbacks.add(remote);
    if (!allCached(placed) && (fallback || runsOffMap(placed, tag, accepts)))
      toll.downloads.add(remote);
  }
  return toll;
}

const allCached = (placed: Placed[]): boolean => placed.every(({ copy }) => copy.cached);

// The remotes that run part of the package off the map and part on it, ship a specifier outside the copies the
// serving build publishes, or ship the package at two tags; without a serving build, every remote with a copy on
// the map. Each serves the whole package from its own build instead, so none of its files imports another build's.
export function fallbacksOf(
  externals: PackageExternals,
  serving: ServingBuild | undefined,
  accepts: AcceptsTag
): RemoteName[] {
  const consumers = consumersOf(externals);
  const surface: Surface = serving ? surfaceOf(consumers, serving) : new Map();
  return [...consumers]
    .filter(
      ([remote, placed]) =>
        remote !== serving?.remote && fallsBack(placed, surface, serving?.tag, accepts)
    )
    .map(([remote]) => remote);
}

export function scopeFallbacks(
  externals: readonly (readonly [ExternalName, SharedExternal])[],
  serving: ServingBuild | undefined,
  accepts: AcceptsTag
): void {
  const remotes = fallbacksOf(externals, serving, accepts);
  for (const [, external] of externals)
    external.versions = scopeRemotes(external.versions, remotes);
}

// The first copy, in record order, that `rejectsServingTag` while its remote's coverage alone (`splitsPackage`)
// would keep it on the map: a remote its coverage already sends to its own build never refuses.
export function strictObjectorOf(
  externals: PackageExternals,
  serving: ServingBuild,
  accepts: AcceptsTag
): (ServingObjector & { external: ExternalName }) | undefined {
  const consumers = consumersOf(externals);
  const surface = surfaceOf(consumers, serving);
  for (const [name, external] of externals)
    for (const row of external.versions)
      for (const copy of row.remotes)
        if (
          copy.name !== serving.remote &&
          rejectsServingTag({ row, copy }, surface, serving.tag, accepts) &&
          !splitsPackage(consumers.get(copy.name)!, surface, serving.tag, accepts)
        )
          return { external: name, copy, tag: row.tag };
  return undefined;
}

// Each specifier the serving build publishes, at the tag of the row it publishes it from.
type Surface = Map<Specifier, VersionName>;

// Up to here a scan beats building the sorted key; a surface past it is looked up by that key after the scan.
export const SCANNED_SURFACES_PER_TAG = 8;

function sameSurface(a: Surface, b: Surface): boolean {
  if (a.size !== b.size) return false;
  for (const [specifier, tag] of a) if (b.get(specifier) !== tag) return false;
  return true;
}

function surfaceOf(consumers: Map<RemoteName, Placed[]>, serving: ServingBuild): Surface {
  const surface: Surface = new Map();
  for (const p of consumers.get(serving.remote) ?? [])
    if ((p.row.tag === serving.tag && onMap(p)) || leadsShareRow(p))
      for (const s in p.copy.entries) if (!surface.has(s)) surface.set(s, p.row.tag);
  return surface;
}

// followServingBuild leaves these rows shared, so a host's copies at its other tags publish too.
const leadsShareRow = ({ row, copy }: Placed): boolean =>
  row.action === 'share' && row.remotes[0] === copy;

const onMap = ({ row }: Placed): boolean => row.action !== 'scope';

// A remote with no copy on the map already runs the package wholly from its own build.
function splitsPackage(
  placed: Placed[],
  surface: Surface,
  tag: VersionName | undefined,
  accepts: AcceptsTag
): boolean {
  const uncovered = (p: Placed) =>
    Object.keys(p.copy.entries).some(s => {
      const servedAt = surface.get(s);
      // A strict copy takes a host's file at another tag only where its range accepts it; the serving tag is
      // `rejectsServingTag`'s to judge.
      return servedAt === undefined || (servedAt !== tag && rejectsTag(p, servedAt, accepts));
    });
  return (
    placed.some(onMap) && (shipsTwoTags(placed) || placed.some(p => !onMap(p) || uncovered(p)))
  );
}

// Whether a runtime load's copies split the package over the claims the committed map serves of it, as
// `splitsPackage` judges a remote at init.
export function loadSplitsPackage(
  pkg: ExternalName,
  copies: readonly { tag: VersionName; copy: SharedVersionMeta }[],
  claims: readonly (readonly [Specifier, { tag: VersionName }])[],
  accepts: AcceptsTag
): boolean {
  const root = claims.find(([specifier]) => specifier === pkg)?.[1];
  // Without a root claim the serving tag is unknown: every claim counts as at it, so only a gap or two tags
  // split.
  const servingTag = root?.tag ?? claims[0]![1].tag;
  const surface: Surface = new Map(
    claims.map(([specifier, { tag }]) => [specifier, root ? tag : servingTag])
  );
  // Each loaded copy as the share row it would join; a loader is never the host.
  const placed: Placed[] = copies.map(({ tag, copy }) => ({
    row: { tag, action: 'share', host: false, remotes: [copy] },
    copy,
  }));
  return splitsPackage(placed, surface, servingTag, accepts);
}

function fallsBack(
  placed: Placed[],
  surface: Surface,
  tag: VersionName | undefined,
  accepts: AcceptsTag
): boolean {
  return (
    splitsPackage(placed, surface, tag, accepts) ||
    (tag !== undefined && placed.some(p => rejectsServingTag(p, surface, tag, accepts)))
  );
}

// A strict copy on the map whose range rejects the serving tag, where the serving build publishes one of its
// files. A scoped copy already runs its own build, so it never objects.
function rejectsServingTag(
  p: Placed,
  surface: Surface,
  tag: VersionName,
  accepts: AcceptsTag
): boolean {
  return (
    onMap(p) &&
    rejectsTag(p, tag, accepts) &&
    Object.keys(p.copy.entries).some(s => surface.get(s) === tag)
  );
}

const rejectsTag = ({ row, copy }: Placed, tag: VersionName, accepts: AcceptsTag): boolean =>
  copy.strictVersion && !accepts(tag, row.tag, copy.requiredVersion);

// The host serves every tag it ships; any other remote shipping two tags has no one build to serve or follow.
const shipsTwoTags = (placed: Placed[]): boolean =>
  !placed.some(p => p.row.host && p.row.remotes[0] === p.copy) &&
  placed.some(p => p.row.tag !== placed[0]!.row.tag);

function runsOffMap(placed: Placed[], tag: VersionName, accepts: AcceptsTag): boolean {
  return placed.some(p => !onMap(p) || rejectsTag(p, tag, accepts));
}
