import type { ScopedExternals } from 'lib/core/1.domain/externals/external.contract';
import type { StorageConfig, StorageEntry } from 'lib/core/2.app/config/storage.contract';
import type { ForScopedExternalsStorage } from 'lib/core/2.app/driving-ports/for-scoped-externals-storage.port';
import type { RemoteName, ScopedVersion } from 'lib/core/1.domain';
import { Optional } from 'lib/utils/optional';

const createScopedExternalsRepository = (config: StorageConfig): ForScopedExternalsStorage => {
  const STORAGE: StorageEntry<ScopedExternals> = config.storage('scoped-externals', {});

  if (config.clearStorage) STORAGE.clear();

  const _cache: ScopedExternals = STORAGE.get() ?? {};

  let _dirty = false;

  return {
    addExternal: function (remoteName: RemoteName, external: string, version: ScopedVersion) {
      if (!_cache[remoteName]) _cache[remoteName] = {};
      _cache[remoteName][external] = version;
      _dirty = true;
      return this;
    },
    remove: function (remoteName: RemoteName) {
      if (remoteName in _cache) {
        delete _cache[remoteName];
        _dirty = true;
      }
      return this;
    },
    getAll: function () {
      return _cache;
    },
    tryGet: function (remoteName: string) {
      return Optional.of(_cache[remoteName]);
    },
    commit: function () {
      if (!_dirty) return this;
      STORAGE.set(_cache);
      _dirty = false;
      return this;
    },
  };
};

export { createScopedExternalsRepository };
