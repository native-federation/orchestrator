import type { RemoteEntry } from 'lib/core/1.domain/remote-entry/remote-entry.contract';

export type ForProcessingRemoteEntries = (remoteEntries: RemoteEntry[]) => Promise<RemoteEntry[]>;
