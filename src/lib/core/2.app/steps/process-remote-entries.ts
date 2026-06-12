import type { ForProcessingRemoteEntries } from '../driver-ports/init/for-processing-remote-entries.port';
import type { RemoteEntry, SharedInfo } from 'lib/core/1.domain';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { createStoreRemoteEntry, type SharedExternalContext } from './store-remote-entry';

export function createProcessRemoteEntries(
  config: LoggingConfig & ModeConfig,
  ports: Pick<
    DrivingContract,
    | 'remoteInfoRepo'
    | 'sharedExternalsRepo'
    | 'scopedExternalsRepo'
    | 'sharedChunksRepo'
    | 'versionCheck'
  >
): ForProcessingRemoteEntries {
  const storeRemoteEntry = createStoreRemoteEntry(config, ports, 2);

  /**
   * Step 2: Merge the remote-info, externals and chunks of the provided remoteEntry
   * objects into the cache. Shared externals are only registered here; resolution
   * happens later in determine-shared-externals, per scope, with global knowledge.
   */
  return remoteEntries => {
    try {
      remoteEntries.forEach(remoteEntry => storeRemoteEntry(remoteEntry, addSharedExternal));
      return Promise.resolve(remoteEntries);
    } catch (e) {
      return Promise.reject(e);
    }
  };

  function addSharedExternal(
    remoteEntry: RemoteEntry,
    _sharedInfo: SharedInfo,
    { tag, remote, cached, scopeType, assertSameVersionCompatibility, commit }: SharedExternalContext
  ): void {
    const matchingVersion = cached.versions.find(version => version.tag === tag);

    if (matchingVersion) {
      assertSameVersionCompatibility(matchingVersion);

      if (!matchingVersion.host && !!remoteEntry?.host) {
        matchingVersion.host = true;
        matchingVersion.remotes.unshift(remote);
      } else matchingVersion.remotes.push(remote);
    } else {
      if (scopeType !== 'strict') cached.dirty = true;
      cached.versions.push({
        tag,
        action: scopeType === 'strict' ? 'share' : 'skip',
        host: !!remoteEntry?.host,
        remotes: [remote],
      });
    }

    commit();
  }
}
