import type { ImportMapConfig } from 'lib/core/2.app/config/import-map.contract';
import { replaceInDOM } from './replace-in-dom';
import { preloadInDOM } from './preload-in-dom';
import { getTrustedTypesPolicy } from './trusted-types';

declare function importShim<T>(url: string): T;

const useShimImportMap = (
  cfg: { shimMode: boolean } = { shimMode: false },
  trustedTypesPolicyName: string | false = 'nfo'
): ImportMapConfig => ({
  loadModuleFn: url => {
    const trusted = getTrustedTypesPolicy(trustedTypesPolicyName).createScriptURL(url);
    return importShim(trusted);
  },
  setImportMapFn: replaceInDOM(
    cfg.shimMode ? 'importmap-shim' : 'importmap',
    trustedTypesPolicyName
  ),
  // es-module-shims reuses only the fetches of the link type that matches its mode.
  preloadModulesFn: preloadInDOM(cfg.shimMode ? 'modulepreload-shim' : 'modulepreload'),
  reloadBrowserFn: () => {
    window.location.reload();
  },
});

export { useShimImportMap };
