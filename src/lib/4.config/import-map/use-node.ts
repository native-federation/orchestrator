import type { ImportMap } from 'lib/1.domain';
import type { ImportMapConfig } from 'lib/2.app/config/import-map.contract';
import {
  getNodeLoaderClient,
  type NodeLoaderClient,
  type HostInstanceKeys,
} from 'lib/3.adapters/node/node-loader.client';

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
    setHostInstancesFn: (keys: HostInstanceKeys) => nodeLoader.setHostInstances(keys).then(() => keys),
    reloadBrowserFn: () => {
      /* no-op */
    },
  };
};

export { useNodeImportMap };
