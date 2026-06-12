import type { ConfigContract } from '../2.app/config/config.contract';
import type { DrivingContract } from '../2.app/driving-ports/driving.contract';
import type { InitRemoteEntryFlow, RemoteRef } from '../2.app/driver-ports/init/flow.contract';
import type {
  LoadRemoteModule,
  LoadRemoteModuleOf,
  NativeFederationResult,
} from '../init-federation.contract';

export const createStateDump =
  (config: ConfigContract, adapters: DrivingContract) =>
  (msg: string): void =>
    config.log.debug(0, msg, {
      remotes: { ...adapters.remoteInfoRepo.getAll() },
      'shared-externals': adapters.sharedExternalsRepo
        .getScopes({ includeGlobal: true })
        .reduce(
          (acc, scope) => ({ ...acc, [scope]: adapters.sharedExternalsRepo.getFromScope(scope) }),
          {}
        ),
      'scoped-externals': adapters.scopedExternalsRepo.getAll(),
    });

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
  const stateDump = createStateDump(config, adapters);

  const initRemoteEntry = async (
    remoteEntryUrl: string,
    remote?: RemoteRef
  ): Promise<NativeFederationResult> => {
    const remoteName = typeof remote === 'string' ? remote : remote?.name;
    return initRemoteEntryFlow(remoteEntryUrl, remote)
      .catch(e => {
        stateDump(`[dynamic-init][${remoteName ?? remoteEntryUrl}] STATE DUMP`);
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
