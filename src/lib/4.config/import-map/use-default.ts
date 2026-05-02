import type { ImportMapConfig } from 'lib/2.app/config/import-map.contract';
import { replaceInDOM } from './replace-in-dom';
import { getTrustedTypesPolicy } from './trusted-types';

const useDefaultImportMap = (
  trustedTypesPolicyName: string | false = 'nfo'
): ImportMapConfig => ({
  loadModuleFn: url => {
    const trusted = getTrustedTypesPolicy(trustedTypesPolicyName).createScriptURL(url);
    return import(/* @vite-ignore */ trusted);
  },
  setImportMapFn: replaceInDOM('importmap', trustedTypesPolicyName),
  reloadBrowserFn: () => {
    window.location.reload();
  },
});

export { useDefaultImportMap };
