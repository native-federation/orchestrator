import type { ImportMapConfig } from 'lib/2.app/config/import-map.contract';
import { replaceInDOM } from './replace-in-dom';
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
  reloadBrowserFn: () => {
    window.location.reload();
  },
});

export { useShimImportMap };
