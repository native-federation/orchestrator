import type { RemoteEntry } from 'lib/1.domain/remote-entry/remote-entry.contract';
import type {
  FederationManifest,
  RemoteEntryDescriptor,
  RemoteEntryUrl,
} from 'lib/1.domain/remote-entry/manifest.contract';
import type { RemoteName } from 'lib/1.domain/remote/remote-info.contract';
import type { ForGettingRemoteEntries } from '../../driver-ports/init/for-getting-remote-entries.port';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import { NFError } from 'lib/native-federation.error';
import type { ModeConfig } from '../../config/mode.contract';
import type { HostConfig } from '../../config/host.contract';
import * as _path from 'lib/utils/path';

export function createGetRemoteEntries(
  config: LoggingConfig & ModeConfig & HostConfig,
  ports: Pick<
    DrivingContract,
    'remoteEntryProvider' | 'manifestProvider' | 'remoteInfoRepo' | 'sse'
  >
): ForGettingRemoteEntries {
  /**
   * Step 1: Fetch the remoteEntry JSON objects:
   *
   * A Manifest or URL to a Manifest is used as the input.  Based on the defined remotes
   * in the manifest, the library will download the remoteEntry.json files which contain the
   * metadata of the defined remotes (name, exposed modules and required dependencies a.k.a. externals)
   *
   * @param config
   * @param adapters
   * @returns A list of the remoteEntry json objects
   */
  return (remotesOrManifestUrl = {}) => {
    const manifestPromise = config.manifestIntegrity
      ? ports.manifestProvider.provide(remotesOrManifestUrl, {
          integrity: config.manifestIntegrity,
        })
      : ports.manifestProvider.provide(remotesOrManifestUrl);

    return manifestPromise
      .catch(e => {
        config.log.error(1, 'Could not fetch manifest.', e);
        return Promise.reject(new NFError('Failed to fetch manifest'));
      })
      .then(addHostRemoteEntry)
      .then(fetchRemoteEntries)
      .then(removeSkippedRemotes)
      .then(checkForSSE);
  };

  function addHostRemoteEntry(manifest: FederationManifest): FederationManifest {
    if (!config.hostRemoteEntry) return manifest;

    const { name, url, cacheTag, integrity } = config.hostRemoteEntry;
    const urlWithCache = cacheTag ? `${url}?cacheTag=${cacheTag}` : url;

    return {
      ...manifest,
      [name]: integrity ? { url: urlWithCache, integrity } : urlWithCache,
    };
  }

  function normalizeEntry(descriptor: RemoteEntryDescriptor): {
    url: RemoteEntryUrl;
    integrity?: string;
  } {
    return typeof descriptor === 'string' ? { url: descriptor } : descriptor;
  }

  async function fetchRemoteEntries(manifest: FederationManifest): Promise<(RemoteEntry | false)[]> {
    const fetchPromises = Object.entries(manifest).map(([remoteName, descriptor]) =>
      fetchRemoteEntry(remoteName, descriptor)
    );
    return Promise.all(fetchPromises);
  }

  async function fetchRemoteEntry(
    remoteName: RemoteName,
    descriptor: RemoteEntryDescriptor
  ): Promise<RemoteEntry | false> {
    const { url: remoteEntryUrl, integrity } = normalizeEntry(descriptor);
    let isOverride = false;
    let skip = false;

    ports.remoteInfoRepo.tryGet(remoteName).ifPresent(cachedRemoteInfo => {
      if (
        config.profile.overrideCachedRemotes !== 'never' &&
        (remoteEntryUrl !== _path.join(cachedRemoteInfo.scopeUrl, 'remoteEntry.json') ||
          config.profile.overrideCachedRemotesIfURLMatches)
      ) {
        config.log.debug(1, `Overriding existing remote '${remoteName}' with '${remoteEntryUrl}'.`);
        isOverride = true;
      } else {
        config.log.debug(1, `Found remote '${remoteName}' in storage, omitting fetch.`);
        skip = true;
      }
    });

    if (skip) return false;

    try {
      const remoteEntry = integrity
        ? await ports.remoteEntryProvider.provide(remoteEntryUrl, { integrity })
        : await ports.remoteEntryProvider.provide(remoteEntryUrl);

      config.log.debug(
        1,
        `Fetched '${remoteEntry.name}' from '${remoteEntry.url}', exposing: ${JSON.stringify(remoteEntry.exposes)}`
      );

      return prepareRemoteEntry(remoteEntry, remoteName, isOverride);
    } catch (error) {
      if (config.strict.strictRemoteEntry) {
        config.log.error(1, `Could not fetch remote '${remoteName}'.`, error);
        return Promise.reject(new NFError(`Could not fetch remote '${remoteName}'`));
      }
      config.log.warn(1, `Could not fetch remote '${remoteName}'. skipping init.`, error);

      return Promise.resolve(false);
    }
  }

  function prepareRemoteEntry(
    remoteEntry: RemoteEntry,
    expectedRemoteName: string,
    isOverride: boolean
  ): RemoteEntry {
    if (isOverride) remoteEntry.override = isOverride;

    if (!!config.hostRemoteEntry && expectedRemoteName === config.hostRemoteEntry.name) {
      remoteEntry.host = true;
      remoteEntry.name = config.hostRemoteEntry!.name;
    }

    if (remoteEntry.name !== expectedRemoteName) {
      const errorDetails = `Fetched remote '${remoteEntry.name}' does not match requested '${expectedRemoteName}'.`;
      if (config.strict.strictRemoteEntry) {
        throw new NFError(errorDetails);
      }
      config.log.warn(1, `${errorDetails} Omitting expected name.`);
    }

    return remoteEntry;
  }

  function removeSkippedRemotes(remoteEntries: (RemoteEntry | false)[]): RemoteEntry[] {
    return remoteEntries.filter((entry): entry is RemoteEntry => entry !== false);
  }

  function checkForSSE(remoteEntries: RemoteEntry[]): RemoteEntry[] {
    if (config.sse) {
      remoteEntries.forEach(entry => {
        if (entry.buildNotificationsEndpoint) {
          ports.sse.watchRemoteBuilds(
            _path.join(_path.getScope(entry.url), entry.buildNotificationsEndpoint)
          );
          config.log.debug(1, `Registered SSE endpoint of remote '${entry.name}' `);
          return;
        }
        config.log.debug(1, `Remote ${entry.name} has no defined 'buildNotificationsEndpoint'`);
      });
    }

    return remoteEntries;
  }
}
