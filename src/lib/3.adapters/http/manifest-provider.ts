import type { Manifest } from 'lib/1.domain';
import type { ForProvidingManifest } from 'lib/2.app/driving-ports/for-providing-manifest.port';
import { NFError } from 'lib/native-federation.error';
import { verifyIntegrity } from 'lib/utils/integrity';

const createManifestProvider = (): ForProvidingManifest => {
  const ensureOk = (response: Response) => {
    if (!response.ok)
      return Promise.reject(new NFError(`${response.status} - ${response.statusText}`));
    return response;
  };

  const formatError = (manifestUrl: string) => (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    throw new NFError(`Fetch of '${manifestUrl}' returned ${msg}`);
  };

  return {
    provide: async function (
      remotesOrManifestUrl: string | Manifest,
      opts: { integrity?: string } = {}
    ) {
      if (typeof remotesOrManifestUrl !== 'string') return Promise.resolve(remotesOrManifestUrl);

      const parse = async (response: Response): Promise<Manifest> => {
        if (!opts.integrity) return response.json() as Promise<Manifest>;
        const bytes = await response.arrayBuffer();
        await verifyIntegrity(bytes, opts.integrity);
        return JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
      };

      return fetch(remotesOrManifestUrl)
        .then(ensureOk)
        .then(parse)
        .catch(formatError(remotesOrManifestUrl));
    },
  };
};

export { createManifestProvider };
