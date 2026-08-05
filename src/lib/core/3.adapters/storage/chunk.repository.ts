import type { StorageConfig, StorageEntry } from 'lib/core/2.app/config/storage.contract';
import type { ForSharedChunksStorage } from 'lib/core/2.app/driving-ports/for-shared-chunks-storage.port';
import type { SharedChunks } from 'lib/core/1.domain/externals/chunks.contract';
import { Optional } from 'lib/utils/optional';

const createChunkRepository = (config: StorageConfig): ForSharedChunksStorage => {
  const STORAGE: StorageEntry<SharedChunks> = config.storage('shared-chunks', {});

  if (config.clearStorage) STORAGE.clear();

  const _cache: SharedChunks = STORAGE.get() ?? {};

  let _dirty = false;

  return {
    addOrReplace: function (remoteName: string, bundleName: string, chunks: string[]) {
      if (!_cache[remoteName]) _cache[remoteName] = {};
      _cache[remoteName][bundleName] = chunks;
      _dirty = true;
      return this;
    },
    // Whole-remote: a build that stops chunking a bundle omits the key, so `addOrReplace` cannot clear it.
    remove: function (remoteName: string) {
      if (remoteName in _cache) {
        delete _cache[remoteName];
        _dirty = true;
      }
      return this;
    },
    tryGet: function (remoteName: string, bundleName: string) {
      return Optional.of(_cache[remoteName]?.[bundleName]);
    },
    commit: function () {
      if (!_dirty) return this;
      STORAGE.set(_cache);
      _dirty = false;
      return this;
    },
  };
};

export { createChunkRepository };
