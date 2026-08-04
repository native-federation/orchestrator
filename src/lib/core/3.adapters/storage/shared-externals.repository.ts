import {
  type SharedExternal,
  type SharedExternals,
  GLOBAL_SCOPE,
  STRICT_SCOPE,
} from 'lib/core/1.domain/externals/external.contract';
import type { StorageConfig, StorageEntry } from 'lib/core/2.app/config/storage.contract';
import type { ForSharedExternalsStorage } from 'lib/core/2.app/driving-ports/for-shared-externals-storage.port';
import { Optional } from 'lib/utils/optional';

const createSharedExternalsRepository = (config: StorageConfig): ForSharedExternalsStorage => {
  const STORAGE: StorageEntry<SharedExternals> = config.storage<SharedExternals>(
    'shared-externals',
    { [GLOBAL_SCOPE]: {} }
  );

  if (config.clearStorage) STORAGE.clear();

  const _cache: SharedExternals = STORAGE.get() ?? { [GLOBAL_SCOPE]: {} };

  let _dirty = false;

  return {
    // Read from the cache rather than remembered from this init's entries: a warm init may not refetch
    // the tagged remote at all, and pooling has to coordinate its pool anyway. Exits on the first hit.
    // Per share scope, because a pool never spans one: a tag in another scope is no reason to pool here.
    hasPoolTag: function (shareScope?: string) {
      const scope = _cache[shareScope ?? GLOBAL_SCOPE];
      if (!scope) return false;
      for (const external of Object.values(scope))
        for (const version of external.versions)
          for (const remote of version.remotes) if (remote.pool?.trim()) return true;
      return false;
    },
    getFromScope: function (shareScope?: string) {
      return { ..._cache[shareScope ?? GLOBAL_SCOPE] };
    },
    addOrUpdate: function (externalName: string, external: SharedExternal, shareScope?: string) {
      if (!_cache[shareScope ?? GLOBAL_SCOPE]) _cache[shareScope ?? GLOBAL_SCOPE] = {};
      _cache[shareScope ?? GLOBAL_SCOPE]![externalName] = external;
      _dirty = true;
      return this;
    },
    getScopes: function (o = { includeGlobal: true }) {
      if (o.includeGlobal) return Object.keys(_cache);
      return Object.keys(_cache).filter(s => s !== GLOBAL_SCOPE);
    },
    // Batched: one traversal of the graph per init instead of one per overridden remote.
    removeFromAllScopes: function (remoteNames: ReadonlySet<string>) {
      if (remoteNames.size === 0) return;

      Object.values(_cache).forEach(scope => {
        const removeExternals: string[] = [];

        Object.entries(scope).forEach(([name, external]) => {
          let removedVersion = false;

          for (let i = external.versions.length - 1; i >= 0; i--) {
            const remotes = external.versions[i]!.remotes;

            let keep = 0;
            for (let r = 0; r < remotes.length; r++) {
              if (remoteNames.has(remotes[r]!.name)) continue;
              remotes[keep++] = remotes[r]!;
            }
            if (keep !== remotes.length) {
              remotes.length = keep;
              _dirty = true;
            }

            if (remotes.length === 0) {
              external.versions.splice(i, 1);
              removedVersion = true;
              _dirty = true;
            }
          }

          if (removedVersion) {
            external.dirty = true;
            if (external.versions.length === 0) removeExternals.push(name);
          }
        });
        removeExternals.forEach(name => delete scope[name]);
      });
    },
    scopeType: function (shareScope?: string) {
      switch (shareScope) {
        case GLOBAL_SCOPE:
        case null:
        case undefined:
          return 'global';
        case STRICT_SCOPE:
          return 'strict';
        default:
          return 'shareScope';
      }
    },
    tryGet: function (external: string, shareScope?: string) {
      return Optional.of(_cache[shareScope ?? GLOBAL_SCOPE]?.[external]);
    },
    commit: function () {
      if (!_dirty) return this;
      STORAGE.set(_cache);
      _dirty = false;
      return this;
    },
  };
};

export { createSharedExternalsRepository };
