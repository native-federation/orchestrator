import type { ImportMap } from 'lib/core/1.domain';

export type ImportMapConfig = {
  loadModuleFn: (url: string) => Promise<unknown>;
  setImportMapFn: SetImportMap;
  reloadBrowserFn: () => void;
  preloadModulesFn?: PreloadModules;
};

export type PreloadModules = (urls: string[]) => void;

export type SetImportMap = (
  importMap: ImportMap,
  opts?: { override?: boolean }
) => Promise<ImportMap>;

export type ImportMapOptions = Partial<ImportMapConfig> & {
  /**
   * Trusted Types policy wrapping the default `setImportMapFn` and `loadModuleFn`; `false` opts out.
   * Defaults to `'nfo'`. No effect on browsers without Trusted Types.
   */
  trustedTypesPolicyName?: string | false;
};
