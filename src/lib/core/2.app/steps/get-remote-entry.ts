import type { RemoteEntryUrl } from 'lib/core/1.domain/remote-entry/manifest.contract';
import type { RemoteName } from 'lib/core/1.domain/remote/remote-info.contract';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import { NFError } from 'lib/core/native-federation.error';
import type { ModeConfig } from '../config/mode.contract';
import type { ForGettingRemoteEntry } from '../driver-ports/init/for-getting-remote-entry.port';
import type { RemoteRef } from '../driver-ports/init/flow.contract';
import { Optional } from 'lib/utils/optional';
import type { RemoteEntry } from 'lib/core/1.domain';
import * as _path from 'lib/utils/path';

const normalizeRemoteRef = (remote?: RemoteRef): { name?: RemoteName; integrity?: string } => {
  if (!remote) return {};
  if (typeof remote === 'string') return { name: remote };
  return remote;
};

export function createGetRemoteEntry(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'remoteEntryProvider' | 'remoteInfoRepo' | 'sse'>
): ForGettingRemoteEntry {
  return async (remoteEntryUrl: RemoteEntryUrl, remote?: RemoteRef) => {
    const { name: remoteName, integrity } = normalizeRemoteRef(remote);

    // The committed import map cannot drop a remote's imports, so a dynamic init never replaces a known remote.
    const knownAtUrl = findCachedRemoteAt(remoteEntryUrl);
    if (knownAtUrl) {
      config.log.debug(
        7,
        `Found remote '${knownAtUrl}' at '${remoteEntryUrl}' in storage, omitting fetch.`
      );
      return Optional.empty<RemoteEntry>();
    }
    if (!!remoteName && ports.remoteInfoRepo.contains(remoteName))
      return warnInitialized(remoteName, remoteEntryUrl);

    try {
      const remoteEntry = integrity
        ? await ports.remoteEntryProvider.provide(remoteEntryUrl, { integrity })
        : await ports.remoteEntryProvider.provide(remoteEntryUrl);

      config.log.debug(
        7,
        `[${remoteEntry.name}] Fetched from '${remoteEntry.url}', exposing: ${JSON.stringify(remoteEntry.exposes)}`
      );

      if (!!remoteName && remoteEntry.name !== remoteName) {
        const errorMsg = `Fetched remote '${remoteEntry.name}' does not match requested '${remoteName}'.`;
        if (config.strict.strictRemoteEntry) {
          config.log.error(7, errorMsg);
          throw new NFError('Could not fetch remote entry');
        }
        config.log.warn(7, errorMsg + ' Omitting expected name.');
      }

      if (ports.remoteInfoRepo.contains(remoteEntry.name))
        return warnInitialized(remoteEntry.name, remoteEntryUrl);
      return Optional.of(checkForSSE(remoteEntry));
    } catch (error) {
      config.log.error(
        7,
        `[${remoteName ?? 'unknown'}] Could not fetch remoteEntry from ${remoteEntryUrl}.`,
        error
      );
      return Promise.reject(
        new NFError(`[${remoteName ?? remoteEntryUrl}] Could not fetch remoteEntry.`)
      );
    }
  };

  function warnInitialized(name: RemoteName, remoteEntryUrl: string): Optional<RemoteEntry> {
    const initializedFrom = ports.remoteInfoRepo
      .tryGet(name)
      .map(info => _path.join(info.scopeUrl, 'remoteEntry.json'))
      .get();
    config.log.warn(
      7,
      `[${name}] Already initialized from '${initializedFrom}', ignoring '${remoteEntryUrl}'.`
    );
    return Optional.empty<RemoteEntry>();
  }

  function findCachedRemoteAt(remoteEntryUrl: string): RemoteName | undefined {
    return Object.entries(ports.remoteInfoRepo.getAll()).find(
      ([, info]) => _path.join(info.scopeUrl, 'remoteEntry.json') === remoteEntryUrl
    )?.[0];
  }

  function checkForSSE(entry: RemoteEntry): RemoteEntry {
    if (config.sse) {
      if (entry.buildNotificationsEndpoint) {
        ports.sse.watchRemoteBuilds(
          _path.join(_path.getScope(entry.url), entry.buildNotificationsEndpoint)
        );
        config.log.debug(7, `Registered SSE endpoint of remote '${entry.name}' `);
      } else {
        config.log.debug(7, `Remote ${entry.name} has no defined 'buildNotificationsEndpoint'`);
      }
    }
    return entry;
  }
}
