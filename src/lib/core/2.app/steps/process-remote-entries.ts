import type { ForProcessingRemoteEntries } from '../driver-ports/init/for-processing-remote-entries.port';
import {
  addRemoteToVersion,
  findVersionForTag,
  type RemoteEntry,
  type RemoteName,
  type DenseSharedInfo,
} from 'lib/core/1.domain';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import {
  createRemoveCachedRemoteEntries,
  createStoreRemoteEntry,
  type SharedExternalContext,
} from './store-remote-entry';

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
  const removeCachedRemoteEntries = createRemoveCachedRemoteEntries(ports);

  /**
   * Step 2: Merge the remote-info, externals and chunks of the provided remoteEntry
   * objects into the cache. Shared externals are only registered here; resolution
   * happens later in determine-shared-externals, per scope, with global knowledge.
   */
  return remoteEntries => {
    try {
      const evictPerEntry = evictOverriddenRemotes(remoteEntries);
      remoteEntries.forEach(remoteEntry => {
        if (remoteEntry?.override && evictPerEntry.has(remoteEntry.name)) {
          removeCachedRemoteEntries(new Set([remoteEntry.name]));
        }
        storeRemoteEntry(remoteEntry, addSharedExternal);
      });
      return Promise.resolve(remoteEntries);
    } catch (e) {
      return Promise.reject(e);
    }
  };

  /**
   * Evict every overridden remote in one traversal of the shared-externals graph. Hoisting it ahead
   * of the merge is equivalent because removal only touches records carrying that remote's name —
   * unless a name appears twice in the batch, which `get-remote-entries` permits when
   * `strictRemoteEntry` is off and a fetched entry disagrees with its manifest key.
   *
   * @returns the names that must still be evicted per entry, inside the merge loop.
   */
  function evictOverriddenRemotes(remoteEntries: RemoteEntry[]): Set<RemoteName> {
    const batched = new Set<RemoteName>();
    const repeated = new Set<RemoteName>();

    for (const remoteEntry of remoteEntries) {
      if (!remoteEntry?.override) continue;
      if (batched.delete(remoteEntry.name) || repeated.has(remoteEntry.name)) {
        repeated.add(remoteEntry.name);
        continue;
      }
      batched.add(remoteEntry.name);
    }

    removeCachedRemoteEntries(batched);
    return repeated;
  }

  function addSharedExternal(
    remoteEntry: RemoteEntry,
    _sharedInfo: DenseSharedInfo,
    {
      tag,
      remote,
      cached,
      scopeType,
      assertSameVersionCompatibility,
      commit,
    }: SharedExternalContext
  ): void {
    const matchingVersion = findVersionForTag(cached.versions, tag);

    if (matchingVersion) {
      assertSameVersionCompatibility(matchingVersion);
      addRemoteToVersion(matchingVersion, remote, !matchingVersion.host && !!remoteEntry?.host);
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
