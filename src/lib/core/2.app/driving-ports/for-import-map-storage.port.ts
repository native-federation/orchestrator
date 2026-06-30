import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';

export type ForImportMapStorage = {
  get: () => ImportMap;
  set: (importMap: ImportMap) => ForImportMapStorage;
  /** Deep-merges a partial map into the cache, mirroring the append-only importmap DOM. */
  merge: (importMap: ImportMap) => ForImportMapStorage;
  commit: () => ForImportMapStorage;
};
