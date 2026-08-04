import type { ForDeterminingSharedExternals } from '../driver-ports/init/for-determining-shared-externals.port';
import {
  GLOBAL_SCOPE,
  type SharedExternal,
  type SharedVersion,
  type SharedVersionMeta,
} from 'lib/core/1.domain';
import {
  countUncoveredEntrypoints,
  uncoveredEntrypoints,
  versionDemands,
  versionEntries,
} from 'lib/core/1.domain/externals/basis';
import { NFError } from 'lib/core/native-federation.error';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';

export function createDetermineSharedExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'versionCheck' | 'sharedExternalsRepo'>
): ForDeterminingSharedExternals {
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
    const isCompatible = (tag: string, requiredVersion: string): boolean => {
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

  // Entrypoints declared by the versions `winner` would skip that its own copies can't serve.
  function uncoveredTears(
    external: SharedExternal,
    winner: SharedVersion,
    accepts: (version: SharedVersion, tag: string) => boolean
  ): number {
    const basis = versionEntries(winner);
    return external.versions.reduce((sum, v) => {
      if (v === winner) return sum;
      if (!accepts(v, winner.tag)) return sum;
      return sum + v.remotes.reduce((n, r) => n + countUncoveredEntrypoints(r, basis), 0);
    }, 0);
  }

  function setVersionActions(
    externalName: string,
    external: SharedExternal,
    isCompatible: (tag: string, requiredVersion: string) => boolean
  ) {
    if (external.versions.length === 1) {
      external.versions[0]!.action = 'share';
      external.dirty = false;
      return external;
    }

    // Every compatibility question below is asked of the whole version, not of its basis: see
    // `versionDemands`. Computed once, since the selection loop is O(versions²).
    const demands = new Map<SharedVersion, SharedVersionMeta[]>(
      external.versions.map(v => [v, versionDemands(v)])
    );

    // A version can only be redirected to `tag` if none of its remotes rejects that tag.
    const accepts = (version: SharedVersion, tag: string): boolean =>
      demands.get(version)!.every(d => isCompatible(tag, d.requiredVersion));

    // The remote that makes the redirect unsafe: it rejects `tag` and pinned `strictVersion`,
    // so it has to keep its own build instead of being deduped away.
    const objector = (version: SharedVersion, tag: string): SharedVersionMeta | undefined =>
      demands.get(version)!.find(d => d.strictVersion && !isCompatible(tag, d.requiredVersion));

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
          demands
            .get(vB)!
            .some(d => !d.cached && d.strictVersion && !isCompatible(vA.tag, d.requiredVersion))
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
    external.versions.forEach(v => {
      if (accepts(v, sharedVersion!.tag)) {
        v.action = 'skip';
        return;
      }

      const strict = objector(v, sharedVersion!.tag);

      if (config.strict.strictExternalCompatibility && strict) {
        config.log.error(
          3,
          `[${strict.name}][${externalName}@${v.tag}] Is not compatible with requiredRange '${strict.requiredVersion}' of shared ${externalName}@${sharedVersion!.tag}.`
        );

        throw new NFError(`External ${externalName}@${v.tag} could not be shared.`);
      }
      v.action = strict ? 'scope' : 'skip';
    });

    sharedVersion.action = 'share';

    applyEntrypointCoveragePolicy(externalName, external);

    external.dirty = false;
    return external;
  }

  // Both settings only govern tears *between* versions: copies of the shared tag always merge.
  // `strictEntryPointCoverage` refuses a tear, `profile.scopeUncoveredEntrypoints` scopes the
  // torn copy, otherwise the import-map builders self-fill it.
  function applyEntrypointCoveragePolicy(externalName: string, external: SharedExternal): void {
    const { strictEntryPointCoverage } = config.strict;
    if (!strictEntryPointCoverage && !config.profile.scopeUncoveredEntrypoints) return;

    const tears = findTears(external);
    if (tears.length === 0) return;

    if (strictEntryPointCoverage) {
      const { version, remote, uncovered } = tears[0]!;
      config.log.error(
        3,
        `[${externalName}@${version.tag}][${remote.name}] Entrypoints not covered by the shared version: ${uncovered.join(', ')}.`
      );
      throw new NFError(
        `External ${externalName} could not be shared without tearing entrypoints.`
      );
    }

    scopeTornRemotes(externalName, external, tears);
  }

  function findTears(external: SharedExternal): Tear[] {
    const shared = external.versions.find(v => v.action === 'share');
    if (!shared) return [];

    const basis = versionEntries(shared);
    const tears: Tear[] = [];

    for (const version of external.versions) {
      if (version.action === 'scope') continue;
      // Its own copies are part of the basis, so they can never tear it.
      if (version === shared) continue;

      version.remotes.forEach(remote => {
        const uncovered = uncoveredEntrypoints(remote, basis);
        if (uncovered.length > 0) tears.push({ version, remote, uncovered });
      });
    }

    return tears;
  }

  function scopeTornRemotes(externalName: string, external: SharedExternal, tears: Tear[]): void {
    const torn = new Set(tears.map(t => t.remote));
    const demotedByTag = new Map<string, SharedVersionMeta[]>();

    for (const { version, remote, uncovered } of tears) {
      const group = demotedByTag.get(version.tag);
      if (group) group.push(remote);
      else demotedByTag.set(version.tag, [remote]);

      config.log.debug(
        3,
        `[${externalName}@${version.tag}][${remote.name}] Scoped: entrypoints not covered by the shared version: ${uncovered.join(', ')}.`
      );
    }

    for (const version of external.versions) {
      if (version.remotes.some(r => torn.has(r))) {
        version.remotes = version.remotes.filter(r => !torn.has(r));
      }
    }
    external.versions = external.versions.filter(v => v.remotes.length > 0);

    for (const [tag, remotes] of demotedByTag) {
      const scoped = external.versions.find(v => v.tag === tag && v.action === 'scope');
      if (scoped) scoped.remotes.push(...remotes);
      else external.versions.push({ tag, host: false, action: 'scope', remotes });
    }
  }
}

type Tear = { version: SharedVersion; remote: SharedVersionMeta; uncovered: string[] };
