import type { FederationManifest } from 'lib/core/1.domain';
import type { LoadRemoteModule } from 'lib/core/init-federation.contract';

export type InitResult = {
  loadRemoteModule: LoadRemoteModule;
};

export type InitFlow = (remotesOrManifestUrl: string | FederationManifest) => Promise<InitResult>;

export type RemoteRef = string | { name?: string; integrity?: string };

export type DynamicInitResult<TFederationResult = {}> = TFederationResult & {
  initRemoteEntry: (
    remoteEntryUrl: string,
    remote?: RemoteRef
  ) => Promise<DynamicInitResult<TFederationResult>>;
};

export type InitRemoteEntryFlow = (remoteEntryUrl: string, remote?: RemoteRef) => Promise<void>;
