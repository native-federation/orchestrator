import type { RemoteName } from '../remote/remote-info.contract';

export type RemoteEntryUrl = string;

export type RemoteEntryDescriptor = RemoteEntryUrl | { url: RemoteEntryUrl; integrity?: string };

export type FederationManifest = Record<RemoteName, RemoteEntryDescriptor>;
