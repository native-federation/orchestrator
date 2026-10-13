import type { DeepReadonly } from 'lib/utils/deep-readonly';
import { compareStrings } from 'lib/utils/compare-strings';
import type { RemoteName } from '../remote/remote-info.contract';
import type { AcceptsTag } from './compatibility';
import type { ExternalName, SharedExternal, shareScope } from './external.contract';
import { mergeRows, redirectRow } from './rows';
import { packageOf } from './specifier';
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

export function packagesOf(scope: DeepReadonly<shareScope>): Map<ExternalName, ExternalName[]> {
  const packages = new Map<ExternalName, ExternalName[]>();
  for (const name of Object.keys(scope)) {
    const pkg = packageOf(name);
    const names = packages.get(pkg);
    if (names) names.push(name);
    else packages.set(pkg, [name]);
  }
  return packages;
}

export const isPooled = (externals: PackageExternals): boolean =>
  externals.some(([, e]) => e.poolName !== undefined);

// `externals` are one package's, in record order. A share row of the root fixes the tag its secondaries follow.
export function servingBuildOf(
  externals: PackageExternals,
  accepts: AcceptsTag
): ServingBuild | undefined {
  if (externals.length === 0) return undefined;
  const pkg = packageOf(externals[0]![0]);
  const rootRows = shareRows(externals.find(([name]) => name === pkg)?.[1]);
  const rows = rootRows.length > 0 ? rootRows : externals.flatMap(([, e]) => shareRows(e));

  // The election already chose the global build; ranking again per package could split a pool.
  if (isPooled(externals)) return winnerBuild(externals, rows);

  const ranked = candidatesOf(rows, rootRows, consumersOf(externals), accepts).sort(byServingRank);
  const best = ranked[0];
  return best && { remote: best.remote, tag: best.tag };
}

// Whether `name` still resolves at the serving tag once its other share rows follow the serving build: it has a
// share row there, or the serving build ships it.
export function resolvesAtServingTag(
  externals: PackageExternals,
  serving: ServingBuild,
  name: ExternalName
): boolean {
  const own = externals.find(([n]) => n === name)?.[1];
  if (shareRows(own).some(row => row.tag === serving.tag)) return true;
  return externals.some(([, e]) =>
    shareRows(e).some(row =>
      row.remotes.some(copy => copy.name === serving.remote && name in copy.entries)
    )
  );
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
    if (version.action !== 'share' || version.tag === serving.tag) return [version];
    const rows = redirectRow(version, serving.tag, accepts);
    // A share row redirects into a `scope` row only of copies that reject the tag strictly.
    const scoped = rows.find(row => row.action === 'scope');
    if (scoped && !objector) objector = { copy: scoped.remotes[0]!, tag: scoped.tag };
    return rows;
  });
  external.versions = mergeRows(rebuilt);
  return { external, objector };
}

function shareRows(external: DeepReadonly<SharedExternal> | undefined): Row[] {
  return external?.versions.filter(v => v.action === 'share') ?? [];
}

// Keyed by tag and remote rather than the first row per remote, so record order never decides.
function candidatesOf(
  rows: Row[],
  rootRows: Row[],
  consumers: Map<RemoteName, Placed[]>,
  accepts: AcceptsTag
): ServingCandidate[] {
  const candidates = new Map<string, ServingCandidate>();
  for (const row of rows)
    for (const copy of row.remotes) {
      const key = `${row.tag}|${copy.name}`;
      if (copy.servedBy || candidates.has(key)) continue;
      const basis = copy === row.remotes[0];
      candidates.set(key, {
        remote: copy.name,
        tag: row.tag,
        host: basis && row.host,
        downloads: downloadsOf(copy.name, row.tag, consumers, accepts),
        fallbacks: 0,
        rootBasis: basis && rootRows.includes(row),
      });
    }
  return [...candidates.values()];
}

// The pool's winner, where it ships the root (or, without one, any of the package); otherwise none, and the
// claims keep record order.
function winnerBuild(externals: PackageExternals, rows: Row[]): ServingBuild | undefined {
  const winner = externals.find(([, e]) => e.poolWinner !== undefined)?.[1].poolWinner;
  if (winner === undefined) return undefined;
  const row = rows.find(r => r.remotes.some(copy => copy.name === winner && !copy.servedBy));
  return row && { remote: winner, tag: row.tag };
}

function consumersOf(externals: PackageExternals): Map<RemoteName, Placed[]> {
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

// One per build of the package the page would load beyond what it already has: a cached copy costs nothing.
function downloadsOf(
  serving: RemoteName,
  tag: VersionName,
  consumers: Map<RemoteName, Placed[]>,
  accepts: AcceptsTag
): number {
  let downloads = 0;
  for (const [remote, placed] of consumers) {
    if (placed.every(({ copy }) => copy.cached)) continue;
    if (remote === serving || runsOffMap(placed, tag, accepts)) downloads++;
  }
  return downloads;
}

function runsOffMap(placed: Placed[], tag: VersionName, accepts: AcceptsTag): boolean {
  return placed.some(
    ({ row, copy }) =>
      row.action === 'scope' || (copy.strictVersion && !accepts(tag, row.tag, copy.requiredVersion))
  );
}
