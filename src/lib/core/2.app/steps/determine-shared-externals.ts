import type { ForDeterminingSharedExternals } from '../driver-ports/init/for-determining-shared-externals.port';
import { GLOBAL_SCOPE, type SharedExternal, type SharedVersion } from 'lib/core/1.domain';
import { countUncoveredEntrypoints } from 'lib/core/1.domain/externals/basis';
import { NFError } from 'lib/core/native-federation.error';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';
import { createApplyWinner, type IsCompatible, versionAcceptance } from './apply-winner';

export function createDetermineSharedExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'versionCheck' | 'sharedExternalsRepo'>
): ForDeterminingSharedExternals {
  const applyWinner = createApplyWinner(config);

  /**
   * Step 3: Determine which version is the optimal version to share.
   *
   * The shared external versions that were merged into the cache/storage caused the shared
   * external to be 'dirty', this step cleans all dirty externals in the storage by calculating
   * the most optimal version to share since only 1 version can be shared globally. All other
   * versions that are compatible are skipped and the incompatible ones are defined as scoped external.
   *
   * Check the docs for a full explanation of the dependency resolver.
   *
   * Priority:
   * 1) Latest external defined in 'host' remoteEntry (if available).
   * 2) If defined in config, prioritize latest available version.
   * 3) Find most optimal version, by comparing potential extra downloads per version.
   *
   * @param config
   * @param adapters
   * @returns
   */
  return () => {
    // The selection loop asks this O(versions² × demands) times but has only
    // (candidate tag × distinct requiredVersion) distinct questions to ask. Scoped to one resolve,
    // so the map needs no bound.
    const memo = new Map<string, boolean>();
    const isCompatible: IsCompatible = (tag, requiredVersion) => {
      const key = `${tag}|${requiredVersion}`;
      let hit = memo.get(key);
      if (hit === undefined) {
        hit = ports.versionCheck.isCompatible(tag, requiredVersion);
        memo.set(key, hit);
      }
      return hit;
    };

    for (const shareScope of ports.sharedExternalsRepo.getScopes()) {
      const sharedExternals = ports.sharedExternalsRepo.getFromScope(shareScope);

      try {
        Object.entries(sharedExternals)
          .filter(([_, e]) => e.dirty)
          .forEach(([name, external]) =>
            ports.sharedExternalsRepo.addOrUpdate(
              name,
              setVersionActions(name, external, isCompatible),
              shareScope
            )
          );
      } catch (error) {
        config.log.error(
          3,
          `[${shareScope ?? GLOBAL_SCOPE}] failed to determine shared externals.`,
          {
            sharedExternals,
            error,
          }
        );
        return Promise.reject(
          new NFError(
            `Could not determine shared externals in scope ${shareScope}.`,
            error as Error
          )
        );
      }
    }
    return Promise.resolve();
  };

  // Entrypoints declared by the versions `winner` would skip that its basis can't serve.
  function uncoveredTears(
    external: SharedExternal,
    winner: SharedVersion,
    accepts: (version: SharedVersion, tag: string) => boolean
  ): number {
    const basis = winner.remotes[0]!.entries;
    return external.versions.reduce((sum, v) => {
      if (v === winner) return sum;
      if (!accepts(v, winner.tag)) return sum;
      return sum + v.remotes.reduce((n, r) => n + countUncoveredEntrypoints(r, basis), 0);
    }, 0);
  }

  function setVersionActions(
    externalName: string,
    external: SharedExternal,
    isCompatible: IsCompatible
  ) {
    if (external.versions.length === 1) {
      return applyWinner(externalName, external, external.versions[0]!, isCompatible);
    }

    const acceptance = versionAcceptance(external, isCompatible);
    const { accepts, demands } = acceptance;

    let sharedVersion = external.versions.find(v => v.host);

    if (!sharedVersion && config.profile.latestSharedExternal) {
      sharedVersion = external.versions[0];
    }

    if (!sharedVersion) {
      // find version with least extra downloads, sorted by SEMVER version (O^2 complexity)
      let leastExtraDownloads = Number.MAX_VALUE;
      let leastTears = Number.MAX_VALUE;
      external.versions.forEach(vA => {
        // A version costs an extra download when one of its remotes pinned a range that vA's
        // tag does not satisfy and has not been downloaded yet.
        const extraDownloads = external.versions.filter(vB =>
          demands(vB).some(
            d => !d.cached && d.strictVersion && !isCompatible(vA.tag, d.requiredVersion)
          )
        ).length;
        // Tiebreak equal-download candidates toward the one that leaves fewest entrypoints
        // uncovered across the versions it would skip (fewest tears / scope-promotions).
        if (extraDownloads < leastExtraDownloads) {
          leastExtraDownloads = extraDownloads;
          leastTears = uncoveredTears(external, vA, accepts);
          sharedVersion = vA;
          return;
        }
        if (extraDownloads > leastExtraDownloads) return;

        const tears = uncoveredTears(external, vA, accepts);
        if (tears < leastTears) {
          leastTears = tears;
          sharedVersion = vA;
        }
      });
    }

    if (!sharedVersion) {
      throw new NFError(`[${externalName}] Could not determine shared version!`);
    }

    // Determine action of other versions based on chosen sharedVersion
    return applyWinner(externalName, external, sharedVersion, isCompatible, acceptance);
  }
}
