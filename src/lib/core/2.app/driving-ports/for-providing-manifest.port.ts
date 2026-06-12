import type { FederationManifest } from 'lib/core/1.domain/remote-entry/manifest.contract';

export type ForProvidingManifest = {
  provide: (
    remotesOrManifestUrl: FederationManifest | string,
    opts?: { integrity?: string }
  ) => Promise<FederationManifest>;
};
