import {
  STORAGE_KEYS,
  STORAGE_VERSION_KEY,
  type StorageConfig,
  type StorageEntryHandler,
  type StorageOptions,
} from 'lib/core/2.app/config/storage.contract';
import { globalThisStorageEntry } from './global-this.storage';
import { publishStorageInfo } from './publish-storage-info';
import { ORCHESTRATOR_VERSION } from 'lib/core/4.config/orchestrator-version';

// Every entry goes, not only the outdated one: a warm init skips fetching any remote it still has
// cached, so a dropped externals entry would never be refilled.
const isOutdatedCache = (storage: StorageEntryHandler): boolean => {
  const stamp = storage<string | null>(STORAGE_VERSION_KEY, null);
  if (stamp.get() === ORCHESTRATOR_VERSION) return false;
  stamp.set(ORCHESTRATOR_VERSION);
  return Object.values(STORAGE_KEYS).some(key => storage(key, null).get() !== null);
};

export const createStorageConfig = (override: StorageOptions): StorageConfig => {
  const creator = override.storage ?? globalThisStorageEntry;
  const namespace = override.storageNamespace ?? '__NATIVE_FEDERATION__';
  const storage = creator(namespace);
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
