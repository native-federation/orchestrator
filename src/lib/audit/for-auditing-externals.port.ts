import type { RemoteEntry } from 'lib/core/1.domain';

export type ForAuditingExternals = (remoteEntry: RemoteEntry) => Promise<void>;
