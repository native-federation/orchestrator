import type { RemoteEntry } from 'lib/core/1.domain/remote-entry/remote-entry.contract';
import type { LoadActions } from 'lib/core/1.domain/remote-entry/load-actions.contract';

export type ForUpdatingCache = (remoteEntries: RemoteEntry) => Promise<{
  entry: RemoteEntry;
  actions: LoadActions;
}>;
