type StorageEntry<TValue> = {
  set: (value: TValue) => StorageEntry<TValue>;
  get: () => TValue | undefined;
  clear: () => StorageEntry<TValue>;
};

type StorageEntryKey = number | symbol | string;

type StorageType = 'globalThis' | 'localStorage' | 'sessionStorage' | 'custom';

// `type` is only read to describe the storage on globalThis.__NF_ORCHESTRATOR__; untagged creators report 'custom'.
type StorageEntryCreator = {
  (namespace: string): StorageEntryHandler;
  type?: StorageType;
};

const STORAGE_KEYS = {
  remotes: 'remotes',
  sharedExternals: 'shared-externals',
  scopedExternals: 'scoped-externals',
  sharedChunks: 'shared-chunks',
} as const;

type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

type StorageEntryHandler = <TValue>(key: string, initialValue: TValue) => StorageEntry<TValue>;

type StorageConfig = {
  storage: StorageEntryHandler;
  clearStorage: boolean;
};

type StorageOptions = {
  storage?: StorageEntryCreator;
  clearStorage?: boolean;
  storageNamespace?: string;
  exposeStorageGetter?: boolean;
};

export {
  StorageEntry,
  StorageEntryKey,
  StorageEntryHandler,
  StorageConfig,
  StorageOptions,
  StorageEntryCreator,
  StorageType,
  StorageKey,
  STORAGE_KEYS,
};
