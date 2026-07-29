import type { ForUpdatingCache } from '../driver-ports/init/for-updating-cache';
import {
  type RemoteEntry,
  type DenseSharedInfo,
  type SharedInfoActions,
  type SharedVersion,
  type SharedVersionAction,
  GLOBAL_SCOPE,
} from 'lib/core/1.domain';
import {
  addRemoteToVersion,
  findVersionForTag,
  uncoveredEntrypoints,
} from 'lib/core/1.domain/externals/basis';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import * as _path from 'lib/utils/path';
import { NFError } from 'lib/core/native-federation.error';
import type { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import {
  createRemoveCachedRemoteEntries,
  createStoreRemoteEntry,
  type SharedExternalContext,
} from './store-remote-entry';

export function createUpdateCache(
  config: LoggingConfig & ModeConfig,
  ports: Pick<
    DrivingContract,
    | 'remoteInfoRepo'
    | 'sharedExternalsRepo'
    | 'scopedExternalsRepo'
    | 'sharedChunksRepo'
    | 'versionCheck'
  >
): ForUpdatingCache {
  const storeRemoteEntry = createStoreRemoteEntry(config, ports, 8);
  const removeCachedRemoteEntries = createRemoveCachedRemoteEntries(ports);

  /**
   * Step 8 (dynamic init): merge a runtime-loaded remoteEntry into the cache. The
   * import map is already committed, so shared externals are resolved immediately
   * and additively — an already-shared version stays authoritative.
   */
  return remoteEntry => {
    try {
      const actions: SharedInfoActions = {};

      if (remoteEntry?.override) removeCachedRemoteEntries(new Set([remoteEntry.name]));

      storeRemoteEntry(remoteEntry, (entry, external, ctx) => {
        const { action, sharedVersion } = resolveSharedExternal(entry, external, ctx);
        actions[external.packageName] = { action };

        if (action === 'skip' && sharedVersion?.remotes[0]?.entries) {
          actions[external.packageName]!.covered = Object.keys(sharedVersion.remotes[0].entries);

          if (external.shareScope) {
            actions[external.packageName]!.override = resolveOverrideEntries(
              entry,
              external,
              sharedVersion
            );
          }
        }
      });

      return Promise.resolve({ entry: remoteEntry, actions });
    } catch (error) {
      return Promise.reject(error);
    }
  };

  function resolveSharedExternal(
    remoteEntry: RemoteEntry,
    sharedInfo: DenseSharedInfo,
    {
      tag,
      remote,
      cached,
      scopeType,
      assertSameVersionCompatibility,
      commit,
    }: SharedExternalContext
  ): { action: SharedVersionAction; sharedVersion?: SharedVersion } {
    let action: SharedVersionAction = scopeType === 'strict' ? 'share' : 'skip';

    const sharedVersion = cached.versions.find(c => c.action === 'share');
    const isCompatible =
      !sharedVersion || ports.versionCheck.isCompatible(sharedVersion.tag, remote.requiredVersion);

    if (action === 'skip' && !isCompatible && remote.strictVersion) {
      action = 'scope';
      const errorMsg = `[${sharedInfo.shareScope ?? GLOBAL_SCOPE}][${remoteEntry.name}] ${
        sharedInfo.packageName
      }@${sharedInfo.version} Is not compatible with existing ${sharedInfo.packageName}@${
        sharedVersion!.tag
      } requiredRange '${sharedVersion!.remotes[0]?.requiredVersion}'`;

      if (config.strict.strictExternalCompatibility) {
        config.log.error(8, errorMsg);
        throw new NFError(`Could not process remote '${remoteEntry.name}'`);
      }
      config.log.warn(8, errorMsg);
    }

    if (action === 'skip' && sharedVersion) {
      const uncovered = uncoveredEntrypoints(remote, sharedVersion.remotes[0]!.entries);
      if (uncovered.length > 0) {
        const msg = `[${sharedInfo.shareScope ?? GLOBAL_SCOPE}][${remoteEntry.name}][${sharedInfo.packageName}] Entrypoints not covered by the shared version: ${uncovered.join(', ')}.`;

        if (config.strict.strictEntryPointCoverage) {
          config.log.error(8, msg);
          throw new NFError(`Could not process remote '${remoteEntry.name}'`);
        }
        if (config.profile.scopeUncoveredEntrypoints) {
          config.log.debug(8, msg);
          action = 'scope';
        }
      }
    }

    const matchingVersion = findVersionForTag(cached.versions, tag);

    if (action === 'scope') {
      // Inside a shareable version a later import-map build would redirect it to the basis.
      remote.cached = true;
      const scoped = cached.versions.find(v => v.tag === tag && v.action === 'scope');
      if (scoped) scoped.remotes.push(remote);
      else cached.versions.push({ tag, action, host: false, remotes: [remote] });
    } else if (matchingVersion) {
      assertSameVersionCompatibility(matchingVersion);
      addRemoteToVersion(matchingVersion, remote);
    } else {
      if (!sharedVersion) action = 'share';
      remote.cached = action !== 'skip';
      cached.versions.push({ tag, action, host: false, remotes: [remote] });
    }

    commit();
    return { action, sharedVersion };
  }

  function resolveOverrideEntries(
    remoteEntry: RemoteEntry,
    external: DenseSharedInfo,
    sharedVersion: SharedVersion
  ): Record<string, string> {
    return ports.remoteInfoRepo
      .tryGet(sharedVersion.remotes[0]!.name)
      .map(remote =>
        Object.fromEntries(
          Object.entries(sharedVersion.remotes[0]!.entries).map(([packageName, file]) => [
            packageName,
            _path.join(remote.scopeUrl, file),
          ])
        )
      )
      .orThrow(() => {
        config.log.error(
          8,
          `[${external.shareScope ?? GLOBAL_SCOPE}][${remoteEntry.name}][${
            external.packageName
          }@${external.version}][override] Remote name not found in cache.`
        );
        return new NFError(
          `Could not find override url from remote ${sharedVersion.remotes[0]!.name}`
        );
      });
  }
}
