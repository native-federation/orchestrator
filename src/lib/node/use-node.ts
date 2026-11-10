import type { ImportMap } from 'lib/core/1.domain';
import type { ImportMapConfig } from 'lib/core/2.app/config/import-map.contract';
import { noPreload } from 'lib/core/4.config/import-map/no-preload';
import {
  getNodeLoaderClient,
  type NodeLoaderClient,
  type HostInstanceKeys,
} from 'lib/node/adapters/node-loader.client';

type NodeImportMapConfig = ImportMapConfig & {
  nodeLoader: NodeLoaderClient;
  setHostInstancesFn: (keys: HostInstanceKeys) => Promise<HostInstanceKeys>;
};

const useNodeImportMap = (): NodeImportMapConfig => {
  const nodeLoader = getNodeLoaderClient();
  return {
    nodeLoader,
    loadModuleFn: (url: string) => import(/* @vite-ignore */ url),
    setImportMapFn: (importMap: ImportMap) => nodeLoader.setMap(importMap).then(() => importMap),
    setHostInstancesFn: (keys: HostInstanceKeys) =>
      nodeLoader.setHostInstances(keys).then(() => keys),
    reloadBrowserFn: () => {
      /* no-op */
    },
    // import() would evaluate the module, and the loader thread reads a module only once it is imported.
    preloadModulesFn: noPreload,
  };
};

export { useNodeImportMap };
