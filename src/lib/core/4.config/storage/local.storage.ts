import type { StorageEntryCreator, StorageEntry } from 'lib/core/2.app/config/storage.contract';
import { cloneEntry } from 'lib/utils/clone-entry';

const localStorageEntry: StorageEntryCreator =
  (namespace: string) =>
  <TValue>(key: string, initialValue: TValue) => {
    const entry: StorageEntry<TValue> = {
      get() {
        const fromCache = localStorage.getItem(`${namespace}.${String(key)}`);
        if (!fromCache) return cloneEntry(key, initialValue);
        return JSON.parse(fromCache);
      },
      set(value: TValue): StorageEntry<TValue> {
        localStorage.setItem(`${namespace}.${String(key)}`, JSON.stringify(value));
        return entry;
      },
      clear(): StorageEntry<TValue> {
        localStorage.setItem(`${namespace}.${String(key)}`, JSON.stringify(initialValue));
        return this;
      },
    };
    return entry;
  };

export { localStorageEntry };
