import type { StorageConfig, StorageOptions } from 'lib/core/2.app/config/storage.contract';
import { globalThisStorageEntry } from './global-this.storage';
import { publishStorageInfo } from './publish-storage-info';

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

  return {
    storage,
    clearStorage: override.clearStorage ?? false,
  };
};
