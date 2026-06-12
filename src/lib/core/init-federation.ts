import type { NativeFederationResult } from './init-federation.contract';
import type { NFOptions } from './2.app/config/config.contract';
import type { FederationManifest } from './1.domain';
import {
  createInitFlow,
  createInitRemoteEntryFlow,
  INIT_FLOW_FACTORY,
} from './5.di/flows/init.factory';
import { createDriving } from './5.di/driving.factory';
import { createConfigHandlers } from './5.di/config.factory';
import { createFederationResult, createStateDump } from './5.di/federation-result.factory';

const initFederation = (
  remotesOrManifestUrl: string | FederationManifest,
  options: NFOptions = {}
): Promise<NativeFederationResult> => {
  const { adapters, config } = createDriving(createConfigHandlers(options));

  const factory = INIT_FLOW_FACTORY({ adapters, config });
  const initFlow = createInitFlow(factory);
  const initRemoteEntryFlow = createInitRemoteEntryFlow(factory);

  return initFlow(remotesOrManifestUrl)
    .then(({ loadRemoteModule }) =>
      createFederationResult({ config, adapters, loadRemoteModule, initRemoteEntryFlow })
    )
    .catch(e => {
      createStateDump(config, adapters)(`[init] STATE DUMP`);
      return Promise.reject(e);
    });
};

export { initFederation };
