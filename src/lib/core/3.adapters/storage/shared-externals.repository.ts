import {
  type SharedExternal,
  type SharedExternals,
  GLOBAL_SCOPE,
  STRICT_SCOPE,
} from 'lib/core/1.domain/externals/external.contract';
import {
  STORAGE_KEYS,
  type StorageConfig,
  type StorageEntry,
} from 'lib/core/2.app/config/storage.contract';
import type { ForSharedExternalsStorage } from 'lib/core/2.app/driving-ports/for-shared-externals-storage.port';
import { Optional } from 'lib/utils/optional';

const createSharedExternalsRepository = (config: StorageConfig): ForSharedExternalsStorage => {
  const STORAGE: StorageEntry<SharedExternals> = config.storage<SharedExternals>(
    STORAGE_KEYS.sharedExternals,
    { [GLOBAL_SCOPE]: {} }
  );

  if (config.clearStorage) STORAGE.clear();

  let _cache: SharedExternals = STORAGE.get() ?? { [GLOBAL_SCOPE]: {} };

  const _uncommitted = new Set<string>();

  return {
    getFromScope: function (shareScope?: string) {
      return { ..._cache[shareScope ?? GLOBAL_SCOPE] };
    },
    addOrUpdate: function (externalName: string, external: SharedExternal, shareScope?: string) {
      if (!_cache[shareScope ?? GLOBAL_SCOPE]) _cache[shareScope ?? GLOBAL_SCOPE] = {};
      _cache[shareScope ?? GLOBAL_SCOPE]![externalName] = external;
      _uncommitted.add(shareScope ?? GLOBAL_SCOPE);
      return this;
    },
    getScopes: function (o = { includeGlobal: true }) {
      if (o.includeGlobal) return Object.keys(_cache);
      return Object.keys(_cache).filter(s => s !== GLOBAL_SCOPE);
    },
    // Batched: one traversal of the graph per init instead of one per overridden remote.
    removeFromAllScopes: function (remoteNames: ReadonlySet<string>) {
      if (remoteNames.size === 0) return;

      Object.entries(_cache).forEach(([scopeName, scope]) => {
        const removeExternals: string[] = [];

        Object.entries(scope).forEach(([name, external]) => {
          let removedCopy = false;

          for (let i = external.versions.length - 1; i >= 0; i--) {
            const version = external.versions[i]!;
            const remotes = version.remotes;
            // The host is `remotes[0]` of a flagged version, and the filter below is about to move it.
            const host = version.host ? remotes[0]?.name : undefined;

            let keep = 0;
            for (let r = 0; r < remotes.length; r++) {
              if (remoteNames.has(remotes[r]!.name)) continue;
              remotes[keep++] = remotes[r]!;
            }
            if (keep !== remotes.length) {
              remotes.length = keep;
              removedCopy = true;
              _uncommitted.add(scopeName);
              // Or `determine` keeps granting host precedence to a tag the host has left.
              if (host !== undefined && remoteNames.has(host)) version.host = false;
            }

            if (remotes.length === 0) {
              external.versions.splice(i, 1);
              _uncommitted.add(scopeName);
            }
          }

          // Any lost copy re-elects the external, not only one that emptied a version: the copy may have
          // been the version's basis, or the build a surviving copy's `servedBy` names. A replacement entry
          // that no longer declares this external never marks it dirty itself, so the record would keep
          // pointing at a build that does not serve it any more.
          if (removedCopy) {
            external.dirty = true;
            if (external.versions.length === 0) removeExternals.push(name);
          }
        });

        const lostPools = new Set<string>();
        for (const name of removeExternals) {
          const poolName = scope[name]!.poolName;
          if (poolName !== undefined) lostPools.add(poolName);
          delete scope[name];
        }
        // Nothing dirty is left behind, so mark its pool's siblings dirty or the next init skips the scope.
        if (lostPools.size > 0)
          for (const external of Object.values(scope))
            if (external.poolName !== undefined && lostPools.has(external.poolName))
              external.dirty = true;
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
    uncommittedScopes: function () {
      return [..._uncommitted];
    },
    commit: function () {
      if (_uncommitted.size === 0) return this;
      STORAGE.set(_cache);
      _uncommitted.clear();
      return this;
    },
    rollback: function () {
      _cache = STORAGE.get() ?? { [GLOBAL_SCOPE]: {} };
      _uncommitted.clear();
      return this;
    },
  };
};

export { createSharedExternalsRepository };
