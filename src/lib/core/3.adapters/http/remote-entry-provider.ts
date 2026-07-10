import {
  densifyExternals,
  toDenseSharedInfoFormat,
  type RawRemoteEntry,
  type RemoteEntry,
} from 'lib/core/1.domain/remote-entry/remote-entry.contract';
import type { ForProvidingRemoteEntries } from 'lib/core/2.app/driving-ports/for-providing-remote-entries.port';
import { NFError } from 'lib/core/native-federation.error';
import type { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { verifyIntegrity } from 'lib/utils/integrity';

const createRemoteEntryProvider = (config: ModeConfig): ForProvidingRemoteEntries => {
  const ensureOk = (response: Response) => {
    if (!response.ok)
      return Promise.reject(new Error(`${response.status} - ${response.statusText}`));
    return response;
  };

  const fillEmptyFields = (remoteEntryUrl: string) => (remoteEntry: RemoteEntry) => {
    if (!remoteEntry.exposes) remoteEntry.exposes = [];
    if (!remoteEntry.shared) remoteEntry.shared = [];
    if (!remoteEntry.url) remoteEntry.url = remoteEntryUrl;
    return remoteEntry;
  };

  const normalizeRemoteEntry = (raw: RawRemoteEntry): RemoteEntry => {
    const shared = config.feature.convertFlatSharedInfo
      ? densifyExternals(raw.shared ?? [])
      : toDenseSharedInfoFormat(raw.shared ?? []);
    return { ...raw, shared } as RemoteEntry;
  };

  const formatError = (remoteEntryUrl: string) => (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    throw new NFError(`Fetch of '${remoteEntryUrl}' returned ${msg}`);
  };

  return {
    provide: async function (remoteEntryUrl: string, opts: { integrity?: string } = {}) {
      const parse = async (response: Response): Promise<RawRemoteEntry> => {
        if (!opts.integrity) return response.json() as Promise<RawRemoteEntry>;
        const bytes = await response.arrayBuffer();
        await verifyIntegrity(bytes, opts.integrity);
        return JSON.parse(new TextDecoder().decode(bytes)) as RawRemoteEntry;
      };

      return fetch(remoteEntryUrl)
        .then(ensureOk)
        .then(parse)
        .then(normalizeRemoteEntry)
        .then(fillEmptyFields(remoteEntryUrl))
        .catch(formatError(remoteEntryUrl));
    },
  };
};

export { createRemoteEntryProvider };
