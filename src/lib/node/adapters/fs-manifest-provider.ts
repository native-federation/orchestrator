import type { FederationManifest } from 'lib/core/1.domain';
import type { ForProvidingManifest } from 'lib/core/2.app/driving-ports/for-providing-manifest.port';
import { NFError } from 'lib/core/native-federation.error';
import { verifyIntegrity } from 'lib/utils/integrity';
import { readSourceBytes } from 'lib/node/utils/read-source';

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
