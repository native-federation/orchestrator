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
import { normalizeHostRemoteEntry } from './utils/node/to-url';

export type InitNodeFederationOptions = NFOptions & {
  /**
   * Bridge specifiers to instances already loaded in the host process (dev).
   *
   * Maps each specifier to its module namespace object — e.g.
   * `{ '@angular/core': await import('@angular/core') }`. The host's instances
   * are published on `globalThis.__NF_SHARE_SCOPE__` and the node loader
   * synthesizes a re-export module for each specifier instead of resolving it
   * through the import map, so remotes share the host's singletons.
   *
   * Exports are value snapshots, not live bindings — fine for packages whose
   * exports are stable refs (Angular's classes/functions), not for packages
   * that reassign their exports after init.
   *
   * Omit in production: with no `shareScope`, nothing is published and the
   * loader never routes to the bridge — resolution is import-map only.
   */
  shareScope?: Record<string, object>;
};

/** Global key the node loader reads at module-eval time on the main thread. */
const SHARE_SCOPE_GLOBAL = '__NF_SHARE_SCOPE__';

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

  // Share-scope bridge (dev): publish the host's instances on the global the
  // loader reads, then ship the export-key lists to the loader thread and wait
  // for its ack before the init flow resolves any remote import. With no
  // shareScope this is a no-op and resolution stays import-map only.
  let shareScopeReady: Promise<unknown> = Promise.resolve();
  if (options.shareScope) {
    const globals = globalThis as Record<string, unknown>;
    globals[SHARE_SCOPE_GLOBAL] = {
      ...((globals[SHARE_SCOPE_GLOBAL] as Record<string, object> | undefined) ?? {}),
      ...options.shareScope,
    };
    const keys = Object.fromEntries(
      Object.entries(options.shareScope).map(([specifier, ns]) => [specifier, Object.keys(ns)])
    );
    shareScopeReady = nodeConfig.setShareScopeFn(keys);
  }

  const config = createConfigHandlers({
    ...options,
    hostRemoteEntry: normalizeHostRemoteEntry(options.hostRemoteEntry),
    loadModuleFn: options.loadModuleFn ?? nodeConfig.loadModuleFn,
    setImportMapFn: options.setImportMapFn ?? nodeConfig.setImportMapFn,
    reloadBrowserFn: options.reloadBrowserFn ?? nodeConfig.reloadBrowserFn,
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

  return shareScopeReady
    .then(() => initFlow(remotesOrManifestUrl))
    .then(({ loadRemoteModule }) => nodeConfig.nodeLoader.ready().then(() => loadRemoteModule))
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
          .then(() => nodeConfig.nodeLoader.ready())
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
