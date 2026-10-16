import type { DeepReadonly } from 'lib/utils/deep-readonly';
import { compareStrings } from 'lib/utils/compare-strings';
import type { SharedVersion, SharedVersionMeta } from './version.contract';

const coverage = (remote: SharedVersionMeta): number => Object.keys(remote.entries).length;

// `remotes[0]` is the basis: the copy every consumer of the version resolves to. Host and cached
// outrank coverage because repointing them invalidates a committed import map. An exact tie goes to the
// name, so the basis does not depend on the order remotes register in.
export function isBetterBasis(candidate: SharedVersionMeta, basis: SharedVersionMeta): boolean {
  if (basis.cached !== candidate.cached) return candidate.cached;
  const byCoverage = coverage(candidate) - coverage(basis);
  return byCoverage === 0 ? compareStrings(candidate.name, basis.name) < 0 : byCoverage > 0;
}

export function addRemoteToVersion(
  version: SharedVersion,
  remote: SharedVersionMeta,
  isHost = false
): void {
  if (isHost) {
    version.host = true;
    version.remotes.unshift(remote);
    return;
  }

  const basis = version.remotes[0];
  if (basis && !version.host && isBetterBasis(remote, basis)) {
    version.remotes.unshift(remote);
    return;
  }

  version.remotes.push(remote);
}

// `remotes[0]` answers "who serves this version", never "what does this version demand":
// `requiredVersion`, `strictVersion` and `cached` are per-build settings, so remotes sharing a tag
// can disagree on all three. Negotiation must therefore aggregate over every remote, or basis
// precedence would decide compatibility. Deduped because those settings repeat across a version's
// remotes, which keeps the resolver's O(versions²) selection from also scaling with remote count.
export function versionDemands(version: SharedVersion): SharedVersionMeta[] {
  if (version.remotes.length < 2) return version.remotes;

  const distinct = new Map<string, SharedVersionMeta>();
  for (const remote of version.remotes) {
    const key = `${remote.requiredVersion}|${remote.strictVersion}|${remote.cached}`;
    if (!distinct.has(key)) distinct.set(key, remote);
  }
  return Array.from(distinct.values());
}

// Which copies of a version may publish a specifier, in basis precedence; callers keep the first claim. The
// copies build one tag, so this is what the version ships, not whose files a consumer runs; see
// docs/version-resolver.md#copies-of-one-version.
//
// Only copies that publish their own files count. Pooling places a copy in a subpool running a foreign
// build via `servedBy`, and the import map then names that build's files for it, per consumer — so what
// such a copy bundles answers for nobody but itself, and counting it would promise a specifier no
// consumer of this version can resolve. Pooling keeps a subpool copy out of the basis slot for exactly
// this reason, so a `share` version's basis always survives the skip. `accepts` lets a caller discount a
// copy without dropping its specifiers for the next copy to claim.
export function forEachVersionEntry(
  version: DeepReadonly<SharedVersion>,
  accepts: ((remote: SharedVersionMeta) => boolean) | undefined,
  visit: (entrypoint: string, remote: SharedVersionMeta) => void
): void {
  for (const remote of version.remotes) {
    if (remote.servedBy) continue;
    if (accepts && !accepts(remote)) continue;
    for (const entrypoint in remote.entries) visit(entrypoint, remote);
  }
}

type Covered = Pick<ReadonlySet<string>, 'has'>;

// Counted rather than listed: the resolver's O(versions²) selection loop asks this once per remote per
// candidate.
export function countUncoveredEntrypoints(remote: SharedVersionMeta, covered: Covered): number {
  let uncovered = 0;
  for (const entrypoint in remote.entries) {
    if (!covered.has(entrypoint)) uncovered++;
  }
  return uncovered;
}
