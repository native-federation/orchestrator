import type {
  ImportMapConfig,
  ImportMapOptions,
} from 'lib/core/2.app/config/import-map.contract';
import { useDefaultImportMap } from './use-default';
import { noPreload } from './no-preload';

export const createImportMapConfig = (o: Partial<ImportMapOptions>): ImportMapConfig => {
  const fallback = useDefaultImportMap(o.trustedTypesPolicyName);
  return {
    setImportMapFn: o.setImportMapFn ?? fallback.setImportMapFn,
    loadModuleFn: o.loadModuleFn ?? fallback.loadModuleFn,
    reloadBrowserFn: o.reloadBrowserFn ?? fallback.reloadBrowserFn,
    preloadModulesFn: o.preloadModulesFn ?? defaultPreload(o, fallback),
  };
};

// The DOM preset only helps the default loader: a custom one never reuses its <link> fetches.
const defaultPreload = (o: Partial<ImportMapOptions>, fallback: ImportMapConfig) =>
  o.loadModuleFn ? noPreload : fallback.preloadModulesFn;
