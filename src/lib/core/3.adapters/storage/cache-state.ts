import {
  STORAGE_KEYS,
  type CacheState,
  type StorageEntryHandler,
} from 'lib/core/2.app/config/storage.contract';

// `cache-state` has two writers, the storage config (`version`) and the shared-externals repository
// (`undecidedScopes`). Each write re-reads the stored object, so neither ever drops the other's field.
export const createCacheState = (storage: StorageEntryHandler) => {
  const entry = storage<unknown>(STORAGE_KEYS.cacheState, null);

  const read = (): Partial<CacheState> => {
    const stored = entry.get();
    if (typeof stored !== 'object' || stored === null) return {};
    const { version, undecidedScopes } = stored as Record<string, unknown>;
    return {
      ...(typeof version === 'string' ? { version } : {}),
      ...(Array.isArray(undecidedScopes)
        ? { undecidedScopes: undecidedScopes.filter(s => typeof s === 'string') }
        : {}),
    };
  };

  return {
    read,
    update: (fields: Partial<CacheState>): void => void entry.set({ ...read(), ...fields }),
  };
};
