import type { FederationManifest } from 'lib/1.domain/remote-entry/manifest.contract';

export type ForProvidingManifest = {
  provide: (
    remotesOrManifestUrl: FederationManifest | string,
    opts?: { integrity?: string }
  ) => Promise<FederationManifest>;
};
