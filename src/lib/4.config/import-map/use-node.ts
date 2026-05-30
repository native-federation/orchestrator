import type { ImportMap } from 'lib/1.domain';
import type { ImportMapConfig } from 'lib/2.app/config/import-map.contract';
import {
  getNodeLoaderClient,
  type NodeLoaderClient,
  type ShareScopeKeys,
} from 'lib/3.adapters/node/node-loader.client';

type NodeImportMapConfig = ImportMapConfig & {
  nodeLoader: NodeLoaderClient;
  setShareScopeFn: (keys: ShareScopeKeys) => Promise<ShareScopeKeys>;
};

const useNodeImportMap = (): NodeImportMapConfig => {
  const nodeLoader = getNodeLoaderClient();
  return {
    nodeLoader,
    loadModuleFn: (url: string) => import(/* @vite-ignore */ url),
    setImportMapFn: (importMap: ImportMap) => nodeLoader.setMap(importMap).then(() => importMap),
    setShareScopeFn: (keys: ShareScopeKeys) => nodeLoader.setShareScope(keys).then(() => keys),
    reloadBrowserFn: () => {
      /* no-op */
    },
  };
};

export { useNodeImportMap };
