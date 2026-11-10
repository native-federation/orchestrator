import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';

export type ForBrowserTasks = {
  setImportMapFn: (importMap: ImportMap, opt?: { override?: boolean }) => Promise<ImportMap>;
  importModule: (url: string) => Promise<unknown>;
  // Repeated on every load, so it must be idempotent. Optional: without it nothing is preloaded.
  preloadModules?: (urls: string[]) => void;
};
