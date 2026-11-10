import type { LoadRemoteModule, PreloadRemoteModule } from 'lib/core/init-federation.contract';

export type RemoteModuleAccess = {
  loadRemoteModule: LoadRemoteModule;
  preloadRemoteModule: PreloadRemoteModule;
};

export type ForExposingModuleLoader = () => Promise<RemoteModuleAccess>;
