import {
  STORAGE_KEYS,
  type StorageConfig,
  type StorageEntry,
  type StorageEntryHandler,
  type StorageOptions,
} from 'lib/core/2.app/config/storage.contract';
import type { LogHandler } from 'lib/core/2.app/config/log.contract';
import { cloneEntry } from 'lib/utils/clone-entry';
import { globalThisStorageEntry } from './global-this.storage';
import { publishStorageInfo } from './publish-storage-info';
import { ORCHESTRATOR_VERSION } from 'lib/core/4.config/orchestrator-version';
import { createCacheState } from 'lib/core/3.adapters/storage/cache-state';

// Every entry goes, not only the outdated one: a warm init skips fetching any remote it still has
// cached, so a dropped externals entry would never be refilled.
const isOutdatedCache = (storage: StorageEntryHandler): boolean => {
  const cacheState = createCacheState(storage);
  if (cacheState.read().version === ORCHESTRATOR_VERSION) return false;
  cacheState.update({ version: ORCHESTRATOR_VERSION, undecidedScopes: [] });
  return Object.values(STORAGE_KEYS)
    .filter(key => key !== STORAGE_KEYS.cacheState)
    .some(key => storage(key, null).get() !== null);
};

// After one failed write the page stops persisting and keeps every later write in memory: a cache-state update
// would otherwise re-stamp the version, and a rollback would re-read the half-written records.
const guardWrites = (storage: StorageEntryHandler, log: LogHandler): StorageEntryHandler => {
  let failed = false;
  const memory = new Map<string, unknown>();

  const write = (key: string, value: unknown, persist: () => void): void => {
    if (!failed) {
      try {
        persist();
        return;
      } catch (error) {
        failed = true;
        try {
          // Replaces the stamp with the smallest value, so the next page clears the cache.
          storage(STORAGE_KEYS.cacheState, null).set(null);
        } catch {
          /* the next page may inherit the broken cache */
        }
        log.warn(
          5,
          `Could not save '${key}' to storage; this page runs from memory and the next page starts without a cache.`,
          error
        );
      }
    }
    memory.set(key, cloneEntry(key, value));
  };

  return <TValue>(key: string, initialValue: TValue) => {
    const inner = storage(key, initialValue);
    const entry: StorageEntry<TValue> = {
      get: () => (memory.has(key) ? cloneEntry(key, memory.get(key) as TValue) : inner.get()),
      set: value => {
        write(key, value, () => void inner.set(value));
        return entry;
      },
      clear: () => {
        write(key, initialValue, () => void inner.clear());
        return entry;
      },
    };
    return entry;
  };
};

export const createStorageConfig = (override: StorageOptions, log: LogHandler): StorageConfig => {
  const creator = override.storage ?? globalThisStorageEntry;
  const namespace = override.storageNamespace ?? '__NATIVE_FEDERATION__';
  const storage = guardWrites(creator(namespace), log);
  publishStorageInfo({
    type: creator.type ?? 'custom',
    namespace,
    storage,
    exposeGetter: override.exposeStorageGetter ?? true,
  });
  const outdated = isOutdatedCache(storage);

  return {
    storage,
    clearStorage: (override.clearStorage ?? false) || outdated,
  };
};
