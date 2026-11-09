import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';

export type ForBrowserTasks = {
  setImportMapFn: (importMap: ImportMap, opt?: { override?: boolean }) => Promise<ImportMap>;
  importModule: (url: string) => Promise<unknown>;
  // A fire-and-forget hint, sent after its map is committed and repeated on every load: must be idempotent.
  // Optional, so an adapter written before preloading existed still fits; without it nothing is preloaded.
  preloadModules?: (urls: string[]) => void;
};
