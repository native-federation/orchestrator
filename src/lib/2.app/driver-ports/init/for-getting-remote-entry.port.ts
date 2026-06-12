import type { RemoteEntry } from 'lib/1.domain/remote-entry/remote-entry.contract';
import type { Optional } from 'lib/utils/optional';
import type { RemoteRef } from './flow.contract';

export type ForGettingRemoteEntry = (
  remoteEntryUrl: string,
  remote?: RemoteRef
) => Promise<Optional<RemoteEntry>>;
