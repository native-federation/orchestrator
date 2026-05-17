import type { FederationManifest } from './1.domain';
import type { NFOptions, ConfigContract } from './2.app/config/config.contract';
import type { DrivingContract } from './2.app/driving-ports/driving.contract';
import type { RemoteRef } from './2.app/driver-ports/dynamic-init/flow.contract';
import type { LoadRemoteModuleOf, NativeFederationResult } from './init-federation.contract';

import { createBrowser } from './3.adapters/browser/browser';
import { createVersionCheck } from './3.adapters/checks/version.check';
import { createFsManifestProvider } from './3.adapters/node/fs-manifest-provider';
import { createFsRemoteEntryProvider } from './3.adapters/node/fs-remote-entry-provider';
import { createNoopSSE } from './3.adapters/node/noop-sse';
import { createRemoteInfoRepository } from './3.adapters/storage/remote-info.repository';
import { createScopedExternalsRepository } from './3.adapters/storage/scoped-externals.repository';
import { createSharedExternalsRepository } from './3.adapters/storage/shared-externals.repository';
import { createChunkRepository } from './3.adapters/storage/chunk.repository';

import { createConfigHandlers } from './5.di/config.factory';
import { createInitFlow, INIT_FLOW_FACTORY } from './5.di/flows/init.factory';
import {
  createDynamicInitFlow,
  DYNAMIC_INIT_FLOW_FACTORY,
} from './5.di/flows/dynamic-init.factory';
import { useNodeImportMap } from './4.config/import-map/use-node';

export type InitNodeFederationOptions = NFOptions;

const buildNodeAdapters = (config: ConfigContract): DrivingContract => ({
  versionCheck: createVersionCheck(),
  manifestProvider: createFsManifestProvider(),
  remoteEntryProvider: createFsRemoteEntryProvider(),
  remoteInfoRepo: createRemoteInfoRepository(config),
  scopedExternalsRepo: createScopedExternalsRepository(config),
  sharedExternalsRepo: createSharedExternalsRepository(config),
  sharedChunksRepo: createChunkRepository(config),
  browser: createBrowser(config),
  sse: createNoopSSE(),
});

const initNodeFederation = (
  remotesOrManifestUrl: string | FederationManifest,
  options: InitNodeFederationOptions = {}
): Promise<NativeFederationResult> => {
  const nodeConfig = useNodeImportMap();
  const config = createConfigHandlers({
    ...options,
    // Force Node-side defaults; explicit user overrides still win because
    // createImportMapConfig respects them when present.
    loadModuleFn: options.loadModuleFn ?? nodeConfig.loadModuleFn,
    setImportMapFn: options.setImportMapFn ?? nodeConfig.setImportMapFn,
    reloadBrowserFn: options.reloadBrowserFn ?? nodeConfig.reloadBrowserFn,
    // SSE is meaningless server-side; ignore any value the caller passed.
    sse: false,
  });

  const adapters = buildNodeAdapters(config);

  const stateDump = (msg: string) =>
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

  const initFlow = createInitFlow(INIT_FLOW_FACTORY({ adapters, config }));
  const dynamicInitFlow = createDynamicInitFlow(DYNAMIC_INIT_FLOW_FACTORY({ config, adapters }));

  return initFlow(remotesOrManifestUrl)
    .then(({ loadRemoteModule }) => nodeConfig.bridge.ready().then(() => loadRemoteModule))
    .then(loadRemoteModule => {
      const output = {
        config,
        adapters,
        loadRemoteModule,
        as: <TModule = unknown>() => ({
          loadRemoteModule: loadRemoteModule as LoadRemoteModuleOf<TModule>,
          load: loadRemoteModule as LoadRemoteModuleOf<TModule>,
        }),
        load: loadRemoteModule,
      };

      const initRemoteEntry = async (
        remoteEntryUrl: string,
        remote?: RemoteRef
      ): Promise<NativeFederationResult> => {
        const remoteName = typeof remote === 'string' ? remote : remote?.name;
        return dynamicInitFlow(remoteEntryUrl, remote)
          .catch(e => {
            stateDump(`[dynamic-init][${remoteName ?? remoteEntryUrl}] STATE DUMP`);
            if (config.strict.strictRemoteEntry) return Promise.reject(e);
            else console.warn('Failed to initialize remote entry, continuing anyway.');
            return Promise.resolve();
          })
          .then(() => nodeConfig.bridge.ready())
          .then(() => ({
            ...output,
            initRemoteEntry,
          }));
      };

      return {
        ...output,
        initRemoteEntry,
      };
    })
    .catch(e => {
      stateDump(`[init] STATE DUMP`);
      return Promise.reject(e);
    });
};

export { initNodeFederation };
