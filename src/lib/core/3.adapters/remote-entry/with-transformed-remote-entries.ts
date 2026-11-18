import type { ForProvidingRemoteEntries } from 'lib/core/2.app/driving-ports/for-providing-remote-entries.port';
import type { TransformRemoteEntry } from 'lib/core/2.app/config/mode.contract';
import type { RemoteEntry } from 'lib/core/1.domain/remote-entry/remote-entry.contract';
import { NFError } from 'lib/core/native-federation.error';

export const withTransformedRemoteEntries = (
  provider: ForProvidingRemoteEntries,
  transformRemoteEntryFn: TransformRemoteEntry
): ForProvidingRemoteEntries => {
  const transform = async (entry: RemoteEntry, remoteEntryUrl: string) => {
    let transformed: RemoteEntry | undefined;
    try {
      transformed = await transformRemoteEntryFn(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new NFError(
        `transformRemoteEntryFn failed on '${remoteEntryUrl}': ${msg}`,
        err instanceof Error ? err : undefined
      );
    }
    if (!transformed)
      throw new NFError(
        `transformRemoteEntryFn returned nothing for '${remoteEntryUrl}'; it must return the entry.`
      );
    return transformed;
  };

  return {
    provide: (remoteEntryUrl, opts) =>
      provider.provide(remoteEntryUrl, opts).then(entry => transform(entry, remoteEntryUrl)),
  };
};
