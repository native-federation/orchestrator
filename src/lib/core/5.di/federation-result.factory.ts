import type { ConfigContract } from '../2.app/config/config.contract';
import type { DrivingContract } from '../2.app/driving-ports/driving.contract';
import type { InitRemoteEntryFlow, RemoteRef } from '../2.app/driver-ports/init/flow.contract';
import type {
  LoadRemoteModule,
  LoadRemoteModuleOf,
  NativeFederationResult,
  PreloadRemoteModule,
} from '../init-federation.contract';

export { createStateDump } from '../2.app/steps/rollback-changes';

export const createFederationResult = ({
  config,
  adapters,
  loadRemoteModule,
  // Optional: a host composing init by hand, as before preloading existed, still gets a working result.
  preloadRemoteModule = () => {},
  initRemoteEntryFlow,
  afterInitRemoteEntry,
}: {
  config: ConfigContract;
  adapters: DrivingContract;
  loadRemoteModule: LoadRemoteModule;
  preloadRemoteModule?: PreloadRemoteModule;
  initRemoteEntryFlow: InitRemoteEntryFlow;
  afterInitRemoteEntry?: () => Promise<unknown>;
}): NativeFederationResult => {
  const initRemoteEntry = async (
    remoteEntryUrl: string,
    remote?: RemoteRef
  ): Promise<NativeFederationResult> => {
    return initRemoteEntryFlow(remoteEntryUrl, remote)
      .catch(e => {
        if (config.strict.strictRemoteEntry) return Promise.reject(e);
        else console.warn('Failed to initialize remote entry, continuing anyway.');
        return Promise.resolve();
      })
      .then(() => afterInitRemoteEntry?.())
      .then(() => result);
  };

  const result: NativeFederationResult = {
    config,
    adapters,
    loadRemoteModule,
    load: loadRemoteModule,
    preloadRemoteModule,
    as: <TModule = unknown>() => ({
      loadRemoteModule: loadRemoteModule as LoadRemoteModuleOf<TModule>,
      load: loadRemoteModule as LoadRemoteModuleOf<TModule>,
    }),
    initRemoteEntry,
  };

  return result;
};
