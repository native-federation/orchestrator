import type { RemoteEntry } from 'lib/1.domain/remote-entry/remote-entry.contract';

export type ForProvidingRemoteEntries = {
  provide: (remoteEntryUrl: string, opts?: { integrity?: string }) => Promise<RemoteEntry>;
};
