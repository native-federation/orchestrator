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

export function uncoveredEntrypoints(
  remote: SharedVersionMeta,
  basis: Record<string, string>
): string[] {
  return Object.keys(remote.entries).filter(entrypoint => !(entrypoint in basis));
}

// `uncoveredEntrypoints` without materializing the names: the resolver's O(versions²) selection
// loop asks this once per remote per candidate and only needs the count. Keep the two in sync.
export function countUncoveredEntrypoints(
  remote: SharedVersionMeta,
  basis: Record<string, string>
): number {
  let uncovered = 0;
  for (const entrypoint in remote.entries) {
    if (!(entrypoint in basis)) uncovered++;
  }
  return uncovered;
}
