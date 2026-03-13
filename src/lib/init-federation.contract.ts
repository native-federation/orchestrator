import type { ConfigContract } from './2.app/config/config.contract';
import type { DrivingContract } from './2.app/driving-ports/driving.contract';
import type { DynamicInitResult } from './2.app/driver-ports/dynamic-init/flow.contract';

export type LoadRemoteModule = <TModule = unknown>(
  remoteName: string,
  exposedModule: string
) => Promise<TModule>;

export type LoadRemoteModuleOf<TModule> = (
  remoteName: string,
  exposedModule: string
) => Promise<TModule>;

export type NativeFederationResult = DynamicInitResult<{
  config: ConfigContract;
  adapters: DrivingContract;
  loadRemoteModule: LoadRemoteModule;
  load: LoadRemoteModule;
  as: <TModule = unknown>() => {
    loadRemoteModule: LoadRemoteModuleOf<TModule>;
    load: LoadRemoteModuleOf<TModule>;
  };
}>;
