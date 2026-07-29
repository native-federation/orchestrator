import type { ForProcessingRemoteEntries } from '../driver-ports/init/for-processing-remote-entries.port';
import type { RemoteEntry, RemoteName, DenseSharedInfo } from 'lib/core/1.domain';
import { addRemoteToVersion, findVersionForTag } from 'lib/core/1.domain/externals/basis';
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
    const seen = new Set<RemoteName>();

    for (const remoteEntry of remoteEntries) {
      if (!remoteEntry) continue;
      if (seen.has(remoteEntry.name)) repeated.add(remoteEntry.name);
      seen.add(remoteEntry.name);
      if (remoteEntry.override) batched.add(remoteEntry.name);
    }
    for (const remoteName of repeated) batched.delete(remoteName);

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
    // Resolution is a function of the whole remote set, not of the tag list: a remote joining an
    // existing version can take the basis slot (changing what the version serves) and always adds
    // to `versionDemands` (changing what it accepts). Either way the cached actions are stale.
    if (scopeType !== 'strict') cached.dirty = true;

    const matchingVersion = findVersionForTag(cached.versions, tag);

    if (matchingVersion) {
      assertSameVersionCompatibility(matchingVersion);
      addRemoteToVersion(matchingVersion, remote, !matchingVersion.host && !!remoteEntry?.host);
    } else {
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
