import type { RemoteEntry, SharedInfoActions } from 'lib/core/1.domain';
import type { LoadActions } from 'lib/core/1.domain/remote-entry/load-actions.contract';

export type ForPoolingDynamicExternals = (input: {
  entry: RemoteEntry;
  actions: LoadActions;
}) => Promise<{ entry: RemoteEntry; actions: SharedInfoActions }>;
