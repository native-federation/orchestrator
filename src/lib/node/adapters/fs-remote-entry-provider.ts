import type { RawRemoteEntry } from 'lib/core/1.domain/remote-entry/remote-entry.contract';
import type { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { normalizeRemoteEntry } from 'lib/core/3.adapters/remote-entry/normalize-remote-entry';
import type { ForProvidingRemoteEntries } from 'lib/core/2.app/driving-ports/for-providing-remote-entries.port';
import { NFError } from 'lib/core/native-federation.error';
import { verifyIntegrity } from 'lib/utils/integrity';
import { readSourceBytes } from 'lib/node/utils/read-source';

const createFsRemoteEntryProvider = (config: ModeConfig): ForProvidingRemoteEntries => {
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
        return normalizeRemoteEntry(raw, remoteEntryUrl, config);
      } catch (err) {
        return formatError(remoteEntryUrl)(err);
      }
    },
  };
};

export { createFsRemoteEntryProvider };
