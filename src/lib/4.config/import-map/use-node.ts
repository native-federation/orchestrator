import type { ImportMap } from 'lib/1.domain';
import type { ImportMapConfig } from 'lib/2.app/config/import-map.contract';
import { getLoaderBridge, type LoaderBridge } from 'lib/3.adapters/node/loader-bridge';

const useNodeImportMap = (): ImportMapConfig & { bridge: LoaderBridge } => {
  const bridge = getLoaderBridge();
  return {
    bridge,
    loadModuleFn: (url: string) => import(/* @vite-ignore */ url),
    setImportMapFn: (importMap: ImportMap) => bridge.setMap(importMap).then(() => importMap),
    reloadBrowserFn: () => {
      /* no-op on the server: page reload is a browser concern. */
    },
  };
};

export { useNodeImportMap };
