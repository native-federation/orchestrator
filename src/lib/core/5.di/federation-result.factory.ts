import type { ConfigContract } from '../2.app/config/config.contract';
import type { DrivingContract } from '../2.app/driving-ports/driving.contract';
import type { InitRemoteEntryFlow, RemoteRef } from '../2.app/driver-ports/init/flow.contract';
import type {
  LoadRemoteModule,
  LoadRemoteModuleOf,
  NativeFederationResult,
} from '../init-federation.contract';

export { createStateDump } from '../2.app/flows/state-dump';

export const createFederationResult = ({
  config,
  adapters,
  loadRemoteModule,
  initRemoteEntryFlow,
  afterInitRemoteEntry,
}: {
  config: ConfigContract;
  adapters: DrivingContract;
  loadRemoteModule: LoadRemoteModule;
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
    as: <TModule = unknown>() => ({
      loadRemoteModule: loadRemoteModule as LoadRemoteModuleOf<TModule>,
      load: loadRemoteModule as LoadRemoteModuleOf<TModule>,
    }),
    initRemoteEntry,
  };

  return result;
};
