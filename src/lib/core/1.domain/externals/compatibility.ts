import type { SharedExternal } from './external.contract';
import type { SharedVersion, SharedVersionMeta } from './version.contract';
import { versionDemands } from './basis';

export type AcceptsTag = (offered: string, ownTag: string, requiredVersion: string) => boolean;

// A copy runs the build it ships whatever its range says, so a range that excludes its own version (one
// drifted from the lockfile) never rejects that version. Semver-equal, not string-equal: `v1.0.0` is `1.0.0`.
export function acceptsTag(
  isCompatible: (tag: string, requiredVersion: string) => boolean,
  compare: (a: string, b: string) => number
): AcceptsTag {
  return (offered, ownTag, requiredVersion) =>
    isCompatible(offered, requiredVersion) || offered === ownTag || compare(offered, ownTag) === 0;
}

export type VersionAcceptance = {
  // A version can only be redirected to `tag` if none of its remotes rejects that tag.
  accepts: (version: SharedVersion, tag: string) => boolean;
  // A representative copy that makes the redirect unsafe: it rejects `tag` while `strictVersion` is set,
  // so it keeps its own build instead of being deduped away. One is enough for the message and the
  // strict check; `applyWinner` enumerates the rest itself when it splits the version.
  objector: (version: SharedVersion, tag: string) => SharedVersionMeta | undefined;
};

// Every compatibility question is asked of the whole version, not of its basis: see `versionDemands`.
// Computed once per external, since the selection loop is O(versions²).
export function versionAcceptance(
  external: SharedExternal,
  acceptsTag: AcceptsTag
): VersionAcceptance {
  const demands = new Map<SharedVersion, SharedVersionMeta[]>(
    external.versions.map(v => [v, versionDemands(v)])
  );

  return {
    accepts: (version, tag) =>
      demands.get(version)!.every(d => acceptsTag(tag, version.tag, d.requiredVersion)),
    objector: (version, tag) =>
      demands
        .get(version)!
        .find(d => d.strictVersion && !acceptsTag(tag, version.tag, d.requiredVersion)),
  };
}
