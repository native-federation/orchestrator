import type { ForVersionChecking } from 'lib/core/2.app/driving-ports/for-version-checking.port';
import semverValid from 'semver/functions/valid';
import semverSatisfies from 'semver/functions/satisfies';
import SemVer from 'semver/classes/semver';
import semverMinVersion from 'semver/ranges/min-version';
import semverValidRange from 'semver/ranges/valid';

const createVersionCheck = (): ForVersionChecking => {
  const parsed = new Map<string, SemVer>();
  const parse = (v: string) => {
    let hit = parsed.get(v);
    if (!hit) parsed.set(v, (hit = new SemVer(v, true)));
    return hit;
  };
  const satisfied = new Map<string, Map<string, boolean>>();
  return {
    isValidSemver: function (version: string) {
      return semverValid(version) !== null;
    },
    isCompatible: function (version: string, range: string) {
      let byVersion = satisfied.get(range);
      if (!byVersion) satisfied.set(range, (byVersion = new Map()));
      let hit = byVersion.get(version);
      if (hit === undefined) byVersion.set(version, (hit = semverSatisfies(version, range)));
      return hit;
    },
    compare: function (versionA: string, versionB: string) {
      return parse(versionA).compare(parse(versionB));
    },
    smallestVersion: function (versionRange: string) {
      if (!semverValidRange(versionRange)) return '0.0.0';
      const minVersion = semverMinVersion(versionRange);
      return minVersion?.raw ?? '0.0.0';
    },
  };
};

export { createVersionCheck };
