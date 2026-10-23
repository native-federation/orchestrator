import type {
  RawRemoteEntry,
  RemoteEntry,
} from 'lib/core/1.domain/remote-entry/remote-entry.contract';
import { markDense } from 'lib/core/1.domain/remote-entry/mark-dense';
import type { ForProvidingRemoteEntries } from 'lib/core/2.app/driving-ports/for-providing-remote-entries.port';
import { NFError } from 'lib/core/native-federation.error';
import { verifyIntegrity } from 'lib/utils/integrity';
import { readSourceBytes } from 'lib/node/utils/read-source';

const createFsRemoteEntryProvider = (): ForProvidingRemoteEntries => {
  const fillEmptyFields = (remoteEntryUrl: string) => (remoteEntry: RemoteEntry) => {
    if (!remoteEntry.exposes) remoteEntry.exposes = [];
    if (!remoteEntry.shared) remoteEntry.shared = [];
    if (!remoteEntry.url) remoteEntry.url = remoteEntryUrl;
    return remoteEntry;
  };

  const formatError = (remoteEntryUrl: string) => (err: unknown) => {
    if (err instanceof NFError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new NFError(`Read of '${remoteEntryUrl}' returned ${msg}`);
  };

  return {
    provide: async function (remoteEntryUrl: string, opts: { integrity?: string } = {}) {
      try {
        const bytes = await readSourceBytes(remoteEntryUrl);
        if (opts.integrity) await verifyIntegrity(bytes, opts.integrity);
        const raw = JSON.parse(new TextDecoder().decode(bytes)) as RawRemoteEntry;
        const parsed = { ...raw, shared: markDense(raw.shared ?? []) } as RemoteEntry;
        return fillEmptyFields(remoteEntryUrl)(parsed);
      } catch (err) {
        return formatError(remoteEntryUrl)(err);
      }
    },
  };
};

export { createFsRemoteEntryProvider };
