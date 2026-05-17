import type { ImportMap } from 'lib/1.domain';
import type { ImportMapConfig } from 'lib/2.app/config/import-map.contract';
import {
  getNodeLoaderClient,
  type NodeLoaderClient,
} from 'lib/3.adapters/node/node-loader.client';

const useNodeImportMap = (): ImportMapConfig & { nodeLoader: NodeLoaderClient } => {
  const nodeLoader = getNodeLoaderClient();
  return {
    nodeLoader,
    loadModuleFn: (url: string) => import(/* @vite-ignore */ url),
    setImportMapFn: (importMap: ImportMap) => nodeLoader.setMap(importMap).then(() => importMap),
    reloadBrowserFn: () => {
      /* no-op */
    },
  };
};

export { useNodeImportMap };
