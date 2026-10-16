// `set` stores a copy and `get` returns a fresh one: a repository's uncommitted edits must never reach storage.
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
  cacheState: 'cache-state',
} as const;

type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

// The orchestrator version that wrote the cache, beside the records: a cache stamped with any other is dropped.
// `undecidedScopes` are the share scopes a runtime load wrote since their serving builds were last decided.
type CacheState = { version: string; undecidedScopes: string[] };

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
  CacheState,
};
