import type { FederationManifest } from 'lib/1.domain';
import type { ForProvidingManifest } from 'lib/2.app/driving-ports/for-providing-manifest.port';
import { NFError } from 'lib/native-federation.error';
import { verifyIntegrity } from 'lib/utils/integrity';
import { readSourceBytes } from './read-source';

const createFsManifestProvider = (): ForProvidingManifest => {
  const formatError = (manifestUrl: string) => (err: unknown) => {
    if (err instanceof NFError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new NFError(`Read of '${manifestUrl}' returned ${msg}`);
  };

  return {
    provide: async function (
      remotesOrManifestUrl: string | FederationManifest,
      opts: { integrity?: string } = {}
    ) {
      if (typeof remotesOrManifestUrl !== 'string') return remotesOrManifestUrl;

      try {
        const bytes = await readSourceBytes(remotesOrManifestUrl);
        if (opts.integrity) await verifyIntegrity(bytes, opts.integrity);
        return JSON.parse(new TextDecoder().decode(bytes)) as FederationManifest;
      } catch (err) {
        return formatError(remotesOrManifestUrl)(err);
      }
    },
  };
};

export { createFsManifestProvider };
