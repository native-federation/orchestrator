import type { SharedVersion, SharedVersionMeta } from './version.contract';

const coverage = (remote: SharedVersionMeta): number => Object.keys(remote.entries).length;

// `remotes[0]` is the basis: the copy every consumer of the version resolves to. Host and cached
// outrank coverage because repointing them invalidates a committed import map.
export function isBetterBasis(candidate: SharedVersionMeta, basis: SharedVersionMeta): boolean {
  if (basis.cached !== candidate.cached) return candidate.cached;
  return coverage(candidate) > coverage(basis);
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

// Coverage enforcement can leave a `scope` version beside a shareable one at the same tag.
export function findVersionForTag(
  versions: SharedVersion[],
  tag: string
): SharedVersion | undefined {
  let scoped: SharedVersion | undefined;
  for (const version of versions) {
    if (version.tag !== tag) continue;
    if (version.action !== 'scope') return version;
    scoped ??= version;
  }
  return scoped;
}

// Every copy of a version builds the same tag, so a specifier only some of them bundle is not a
// tear: the version exposes the union of its copies' entrypoints, each served by the first copy
// that declares it — basis precedence first. See
// docs/version-resolver.md#entrypoint-coverage-and-tearing.
//
// Only copies that publish their own files count. Pooling anchors a copy on a foreign build via
// `servedBy`, and the import map then names the anchor's files for it, per consumer — so what such a
// copy bundles answers for nobody but itself, and counting it would promise a specifier no consumer of
// this version can resolve. Pooling keeps an anchored copy out of the basis slot for exactly this
// reason, so a `share` version's basis always survives the skip.
export function versionEntries(version: SharedVersion): Map<string, SharedVersionMeta> {
  const entries = new Map<string, SharedVersionMeta>();
  for (const remote of version.remotes) {
    if (remote.servedBy) continue;
    for (const entrypoint in remote.entries) {
      if (!entries.has(entrypoint)) entries.set(entrypoint, remote);
    }
  }
  return entries;
}

// A `versionEntries` map or a bare name set both answer "can this be served?".
type Covered = Pick<ReadonlySet<string>, 'has'>;

export function uncoveredEntrypoints(remote: SharedVersionMeta, covered: Covered): string[] {
  return Object.keys(remote.entries).filter(entrypoint => !covered.has(entrypoint));
}

// `uncoveredEntrypoints` without materializing the names: the resolver's O(versions²) selection
// loop asks this once per remote per candidate and only needs the count. Keep the two in sync.
export function countUncoveredEntrypoints(remote: SharedVersionMeta, covered: Covered): number {
  let uncovered = 0;
  for (const entrypoint in remote.entries) {
    if (!covered.has(entrypoint)) uncovered++;
  }
  return uncovered;
}
