import type { ImportMap } from 'lib/1.domain';

export type ImportMapConfig = {
  loadModuleFn: (url: string) => Promise<unknown>;
  setImportMapFn: SetImportMap;
  reloadBrowserFn: () => void;
};

export type SetImportMap = (
  importMap: ImportMap,
  opts?: { override?: boolean }
) => Promise<ImportMap>;

export type ImportMapOptions = Partial<ImportMapConfig> & {
  /**
   * Name of the Trusted Types policy used to wrap import-map content and
   * dynamic-import URLs in the default `setImportMapFn` and `loadModuleFn`.
   * Pass `false` to disable the policy (e.g. when the host owns its own
   * Trusted Types pipeline). Defaults to `'nfo'`.
   *
   * Has no effect on browsers that do not support Trusted Types — the wrapper
   * falls back to a transparent pass-through in that case.
   */
  trustedTypesPolicyName?: string | false;
};
