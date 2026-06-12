import type { ForUpdatingCache } from '../../driver-ports/init/for-updating-cache';
import {
  type RemoteEntry,
  type SharedInfo,
  type SharedInfoActions,
  type SharedVersion,
  type SharedVersionAction,
  GLOBAL_SCOPE,
} from 'lib/core/1.domain';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import * as _path from 'lib/utils/path';
import { NFError } from 'lib/core/native-federation.error';
import type { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { createStoreRemoteEntry, type SharedExternalContext } from './store-remote-entry';

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

  /**
   * Step 8 (dynamic init): merge a runtime-loaded remoteEntry into the cache. The
   * import map is already committed, so shared externals are resolved immediately
   * and additively — an already-shared version stays authoritative.
   */
  return remoteEntry => {
    try {
      const actions: SharedInfoActions = {};

      storeRemoteEntry(remoteEntry, (entry, external, ctx) => {
        const { action, sharedVersion } = resolveSharedExternal(entry, external, ctx);
        actions[external.packageName] = { action };

        if (action === 'skip' && external.shareScope && sharedVersion?.remotes[0]?.file) {
          actions[external.packageName]!.override = resolveOverrideUrl(
            entry,
            external,
            sharedVersion
          );
        }
      });

      return Promise.resolve({ entry: remoteEntry, actions });
    } catch (error) {
      return Promise.reject(error);
    }
  };

  function resolveSharedExternal(
    remoteEntry: RemoteEntry,
    sharedInfo: SharedInfo,
    { tag, remote, cached, scopeType, assertSameVersionCompatibility, commit }: SharedExternalContext
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

    const matchingVersion = cached.versions.find(cached => cached.tag === tag);

    if (matchingVersion) {
      assertSameVersionCompatibility(matchingVersion);
      matchingVersion.remotes.push(remote);
    } else {
      if (!sharedVersion) action = 'share';
      remote.cached = action !== 'skip';
      cached.versions.push({ tag, action, host: false, remotes: [remote] });
    }

    commit();
    return { action, sharedVersion };
  }

  function resolveOverrideUrl(
    remoteEntry: RemoteEntry,
    external: SharedInfo,
    sharedVersion: SharedVersion
  ): string {
    return ports.remoteInfoRepo
      .tryGet(sharedVersion.remotes[0]!.name)
      .map(remote => _path.join(remote.scopeUrl, sharedVersion.remotes[0]!.file))
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
