import type { RemoteEntry } from 'lib/1.domain/remote-entry/remote-entry.contract';
import type { ForProvidingRemoteEntries } from 'lib/2.app/driving-ports/for-providing-remote-entries.port';
import { NFError } from 'lib/native-federation.error';
import { verifyIntegrity } from 'lib/utils/integrity';

const createRemoteEntryProvider = (): ForProvidingRemoteEntries => {
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

  const formatError = (remoteEntryUrl: string) => (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    throw new NFError(`Fetch of '${remoteEntryUrl}' returned ${msg}`);
  };

  return {
    provide: async function (remoteEntryUrl: string, opts: { integrity?: string } = {}) {
      const parse = async (response: Response): Promise<RemoteEntry> => {
        if (!opts.integrity) return response.json() as Promise<RemoteEntry>;
        const bytes = await response.arrayBuffer();
        await verifyIntegrity(bytes, opts.integrity);
        return JSON.parse(new TextDecoder().decode(bytes)) as RemoteEntry;
      };

      return fetch(remoteEntryUrl)
        .then(ensureOk)
        .then(parse)
        .then(fillEmptyFields(remoteEntryUrl))
        .catch(formatError(remoteEntryUrl));
    },
  };
};

export { createRemoteEntryProvider };
