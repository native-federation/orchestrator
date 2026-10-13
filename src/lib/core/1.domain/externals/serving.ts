import type { DeepReadonly } from 'lib/utils/deep-readonly';
import { compareStrings } from 'lib/utils/compare-strings';
import type { RemoteName } from '../remote/remote-info.contract';
import type { AcceptsTag } from './compatibility';
import type { ExternalName, SharedExternal, shareScope } from './external.contract';
import { packageOf } from './specifier';
import type { SharedVersion, SharedVersionMeta, VersionName } from './version.contract';

export type ServingBuild = { remote: RemoteName; tag: VersionName };

export type ServingCandidate = ServingBuild & {
  host: boolean;
  downloads: number;
  fallbacks: number;
  rootBasis: boolean;
};

type PackageExternals = readonly (readonly [ExternalName, DeepReadonly<SharedExternal>])[];
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
  if (externals.some(([, e]) => e.poolName !== undefined)) return electedBuild(rows);

  const best = candidatesOf(rows, rootRows, consumersOf(externals), accepts).sort(byServingRank)[0];
  return best && { remote: best.remote, tag: best.tag };
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

function electedBuild(rows: Row[]): ServingBuild | undefined {
  for (const row of rows) {
    const basis = row.remotes.find(copy => !copy.servedBy);
    if (basis) return { remote: basis.name, tag: row.tag };
  }
  return undefined;
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
