import type { RemoteEntry, SharedInfoActions } from 'lib/core/1.domain';

export type ForPoolingDynamicExternals = (input: {
  entry: RemoteEntry;
  actions: SharedInfoActions;
}) => Promise<{ entry: RemoteEntry; actions: SharedInfoActions }>;
