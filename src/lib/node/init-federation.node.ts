import type { FederationManifest } from 'lib/core/1.domain';
import type { NFOptions, ConfigContract } from 'lib/core/2.app/config/config.contract';
import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
import type { NativeFederationResult } from 'lib/core/init-federation.contract';

import { createBrowser } from 'lib/core/3.adapters/browser/browser';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { createFsManifestProvider } from './adapters/fs-manifest-provider';
import { createFsRemoteEntryProvider } from './adapters/fs-remote-entry-provider';
import { createNoopSSE } from './adapters/noop-sse';
import { createRemoteInfoRepository } from 'lib/core/3.adapters/storage/remote-info.repository';
import { createScopedExternalsRepository } from 'lib/core/3.adapters/storage/scoped-externals.repository';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createChunkRepository } from 'lib/core/3.adapters/storage/chunk.repository';
import { createImportMapRepository } from 'lib/core/3.adapters/storage/import-map.repository';

import { createConfigHandlers } from 'lib/core/5.di/config.factory';
import { createInitFlow } from 'lib/core/2.app/flows/init.flow';
import { createInitRemoteEntryFlow } from 'lib/core/2.app/flows/init-remote-entry.flow';
import { INIT_FLOW_FACTORY } from 'lib/core/5.di/init.factory';
import {
  createFederationResult,
  createStateDump,
} from 'lib/core/5.di/federation-result.factory';
import { useNodeImportMap } from './use-node';
import { resolveHostInstances, type HostInstancesOption } from './resolve-host-instances';
import { normalizeHostRemoteEntry } from './utils/to-url';

export type { HostInstancesOption, HostInstancesAuto } from './resolve-host-instances';

export type InitNodeFederationOptions = NFOptions & {
  /**
   * Bridge specifiers to instances already loaded in the host process (dev).
   *
   * The host's instances are published on `globalThis.__NF_HOST_INSTANCES__`
   * and the node loader synthesizes a re-export module for each specifier
   * instead of resolving it through the import map, so remotes share the host's
   * singletons. Three forms:
   *
   * - **Explicit map** — `{ '@angular/core': await import('@angular/core') }`.
   * - **`'all'`** — auto-derive every shared singleton from the host remoteEntry
   *   and import each in the host realm. Needs `hostRemoteEntry`.
   * - **`{ include, exclude }`** — auto-derive, filtered by exact/prefix match,
   *   e.g. `{ include: ['@angular/', 'rxjs', 'zone.js'] }`.
   *
   * This is an escape hatch that bypasses the version resolver, the import map,
   * and integrity checks entirely. Exports are value snapshots, not live
   * bindings — fine for packages whose exports are stable refs (Angular's
   * classes/functions), not for packages that reassign their exports after init.
   *
   * Omit in production: with no `hostInstances`, nothing is published and the
   * loader never routes to the bridge — resolution is import-map only.
   */
  hostInstances?: HostInstancesOption;
};

/** Global key the node loader reads at module-eval time on the main thread. */
const HOST_INSTANCES_GLOBAL = '__NF_HOST_INSTANCES__';

const buildNodeAdapters = (config: ConfigContract): DrivingContract => ({
  versionCheck: createVersionCheck(),
  manifestProvider: createFsManifestProvider(),
  remoteEntryProvider: createFsRemoteEntryProvider(),
  remoteInfoRepo: createRemoteInfoRepository(config),
  scopedExternalsRepo: createScopedExternalsRepository(config),
  sharedExternalsRepo: createSharedExternalsRepository(config),
  sharedChunksRepo: createChunkRepository(config),
  importMapRepo: createImportMapRepository(config),
  browser: createBrowser(config),
  sse: createNoopSSE(),
});

const initNodeFederation = (
  remotesOrManifestUrl: string | FederationManifest,
  options: InitNodeFederationOptions = {}
): Promise<NativeFederationResult> => {
  const nodeConfig = useNodeImportMap();

  const hostRemoteEntry = normalizeHostRemoteEntry(options.hostRemoteEntry);

  const config = createConfigHandlers({
    ...options,
    hostRemoteEntry,
    loadModuleFn: options.loadModuleFn ?? nodeConfig.loadModuleFn,
    setImportMapFn: options.setImportMapFn ?? nodeConfig.setImportMapFn,
    reloadBrowserFn: options.reloadBrowserFn ?? nodeConfig.reloadBrowserFn,
    sse: false,
  });

  const adapters = buildNodeAdapters(config);

  // Host-instance bridge (dev): resolve the instance map (explicit, or
  // auto-derived from the host remoteEntry's shared singletons), publish it on
  // the global the loader reads, ship the export-key lists to the loader thread,
  // and wait for its ack before the init flow resolves any remote import. With
  // no hostInstances this is a no-op and resolution stays import-map only.
  const hostInstancesReady = (async () => {
    const instances = await resolveHostInstances(options.hostInstances, {
      remoteEntryProvider: adapters.remoteEntryProvider,
      hostRemoteEntry,
      log: config.log,
    });
    if (!instances || Object.keys(instances).length === 0) return;

    const globals = globalThis as Record<string, unknown>;
    globals[HOST_INSTANCES_GLOBAL] = {
      ...((globals[HOST_INSTANCES_GLOBAL] as Record<string, object> | undefined) ?? {}),
      ...instances,
    };
    const keys = Object.fromEntries(
      Object.entries(instances).map(([specifier, ns]) => [specifier, Object.keys(ns)])
    );
    await nodeConfig.setHostInstancesFn(keys);
  })();

  const factory = INIT_FLOW_FACTORY({ adapters, config });
  const initFlow = createInitFlow(factory);
  const initRemoteEntryFlow = createInitRemoteEntryFlow(factory);

  return hostInstancesReady
    .then(() => initFlow(remotesOrManifestUrl))
    .then(({ loadRemoteModule }) => nodeConfig.nodeLoader.ready().then(() => loadRemoteModule))
    .then(loadRemoteModule =>
      createFederationResult({
        config,
        adapters,
        loadRemoteModule,
        initRemoteEntryFlow,
        afterInitRemoteEntry: () => nodeConfig.nodeLoader.ready(),
      })
    )
    .catch(e => {
      createStateDump(config, adapters)(`[init] STATE DUMP`);
      return Promise.reject(e);
    });
};

export { initNodeFederation };
