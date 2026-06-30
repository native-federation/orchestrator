import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';
import type { StorageConfig, StorageEntry } from 'lib/core/2.app/config/storage.contract';
import type { ForImportMapStorage } from 'lib/core/2.app/driving-ports/for-import-map-storage.port';

const createImportMapRepository = (config: StorageConfig): ForImportMapStorage => {
  const STORAGE: StorageEntry<ImportMap> = config.storage<ImportMap>('import-map', {
    imports: {},
  });

  if (config.clearStorage) STORAGE.clear();

  let _cache: ImportMap = STORAGE.get() ?? { imports: {} };

  return {
    get: function () {
      return _cache;
    },
    set: function (importMap: ImportMap) {
      _cache = importMap;
      return this;
    },
    commit: function () {
      STORAGE.set(_cache);
      return this;
    },
  };
};

export { createImportMapRepository };
