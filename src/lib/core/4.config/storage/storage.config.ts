import type { StorageConfig, StorageOptions } from 'lib/core/2.app/config/storage.contract';
import { globalThisStorageEntry } from './global-this.storage';
import { publishStorageInfo } from './publish-storage-info';

export const createStorageConfig = (override: StorageOptions): StorageConfig => {
  const creator = override.storage ?? globalThisStorageEntry;
  const namespace = override.storageNamespace ?? '__NATIVE_FEDERATION__';
  publishStorageInfo(creator, namespace);

  return {
    storage: creator(namespace),
    clearStorage: override.clearStorage ?? false,
  };
};
