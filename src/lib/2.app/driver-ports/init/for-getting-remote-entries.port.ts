import type { RemoteEntry } from 'lib/1.domain/remote-entry/remote-entry.contract';
import type { FederationManifest } from 'lib/1.domain/remote-entry/manifest.contract';

export type ForGettingRemoteEntries = (
  remotesOrManifestUrl: string | FederationManifest
) => Promise<RemoteEntry[]>;
