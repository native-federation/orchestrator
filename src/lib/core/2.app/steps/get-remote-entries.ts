import type { RemoteEntry } from 'lib/core/1.domain/remote-entry/remote-entry.contract';
import type {
  FederationManifest,
  RemoteEntryDescriptor,
  RemoteEntryUrl,
} from 'lib/core/1.domain/remote-entry/manifest.contract';
import type { RemoteInfo, RemoteName } from 'lib/core/1.domain/remote/remote-info.contract';
import type { ForGettingRemoteEntries } from '../driver-ports/init/for-getting-remote-entries.port';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import { NFError } from 'lib/core/native-federation.error';
import type { ModeConfig } from '../config/mode.contract';
import type { HostConfig } from '../config/host.contract';
import * as _path from 'lib/utils/path';
import { createRemoveCachedRemoteEntries } from './store-remote-entry';

export function createGetRemoteEntries(
  config: LoggingConfig & ModeConfig & HostConfig,
  ports: Pick<
    DrivingContract,
    | 'remoteEntryProvider'
    | 'manifestProvider'
    | 'remoteInfoRepo'
    | 'scopedExternalsRepo'
    | 'sharedExternalsRepo'
    | 'sharedChunksRepo'
    | 'sse'
  >
): ForGettingRemoteEntries {
  const removeCachedRemoteEntries = createRemoveCachedRemoteEntries(ports);

  /**
   * Step 1: Fetch the remoteEntry JSON objects:
   *
   * A Manifest or URL to a Manifest is used as the input.  Based on the defined remotes
   * in the manifest, the library will download the remoteEntry.json files which contain the
   * metadata of the defined remotes (name, exposed modules and required dependencies a.k.a. externals).
   * With `profile.mergeManifests: false`, stored remotes the manifest doesn't list are dropped first.
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
      .then(dropUnlistedRemotes)
      .then(fetchRemoteEntries)
      .then(removeSkippedRemotes)
      .then(checkForSSE);
  };

  function addHostRemoteEntry(manifest: FederationManifest): FederationManifest {
    if (!config.hostRemoteEntry) return manifest;

    const { name, url, integrity } = config.hostRemoteEntry;

    return {
      ...manifest,
      [name]: integrity ? { url, integrity } : url,
    };
  }

  // Here rather than with the overrides in process-remote-entries: an unlisted remote has no fetched entry, and
  // only this step knows the manifest.
  function dropUnlistedRemotes(manifest: FederationManifest): FederationManifest {
    if (config.profile.mergeManifests !== false) return manifest;

    const listedUrls = new Set(
      Object.values(manifest).map(descriptor => normalizeEntry(descriptor).url)
    );
    // A remote fetched under another name than its manifest key is stored under the fetched one.
    const isListed = (remoteName: RemoteName, info: RemoteInfo) =>
      Object.hasOwn(manifest, remoteName) || listedUrls.has(storedEntryUrl(info));

    const unlisted = new Set(
      Object.entries(ports.remoteInfoRepo.getAll())
        .filter(([remoteName, info]) => !isListed(remoteName, info))
        .map(([remoteName]) => remoteName)
    );
    if (unlisted.size > 0)
      config.log.debug(
        1,
        `Removing stored remotes the manifest doesn't list: ${[...unlisted].join(', ')}.`
      );
    removeCachedRemoteEntries(unlisted);
    return manifest;
  }

  function storedEntryUrl(info: RemoteInfo): RemoteEntryUrl {
    return _path.join(info.scopeUrl, 'remoteEntry.json');
  }

  function normalizeEntry(descriptor: RemoteEntryDescriptor): {
    url: RemoteEntryUrl;
    integrity?: string;
  } {
    return typeof descriptor === 'string' ? { url: descriptor } : descriptor;
  }

  function withCacheTag(url: string, cacheTag?: string): string {
    if (!cacheTag) return url;
    return `${url}${url.includes('?') ? '&' : '?'}cacheTag=${cacheTag}`;
  }

  function resolveCacheTag(remoteName: RemoteName): string | undefined {
    if (
      config.hostRemoteEntry &&
      remoteName === config.hostRemoteEntry.name &&
      config.hostRemoteEntry.cacheTag
    ) {
      return config.hostRemoteEntry.cacheTag;
    }
    return config.profile.cacheTag;
  }

  async function fetchRemoteEntries(
    manifest: FederationManifest
  ): Promise<(RemoteEntry | false)[]> {
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
        (remoteEntryUrl !== storedEntryUrl(cachedRemoteInfo) ||
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

    const fetchUrl = withCacheTag(remoteEntryUrl, resolveCacheTag(remoteName));

    try {
      const remoteEntry = integrity
        ? await ports.remoteEntryProvider.provide(fetchUrl, { integrity })
        : await ports.remoteEntryProvider.provide(fetchUrl);

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
