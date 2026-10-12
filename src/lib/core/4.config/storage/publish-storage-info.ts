import type {
  NFOrchestratorGlobal,
  NFOrchestratorStorageInfo,
} from 'lib/core/2.app/config/orchestrator-global.contract';
import {
  STORAGE_KEYS,
  type StorageEntryHandler,
  type StorageKey,
  type StorageType,
} from 'lib/core/2.app/config/storage.contract';
import { cloneEntry } from 'lib/utils/clone-entry';
import { ORCHESTRATOR_VERSION } from 'lib/core/4.config/orchestrator-version';

const KEYS: readonly StorageKey[] = Object.freeze(Object.values(STORAGE_KEYS));

const isStorageKey = (key: string): key is StorageKey => (KEYS as readonly string[]).includes(key);

type StorageInfoOptions = {
  type: StorageType;
  namespace: string;
  storage: StorageEntryHandler;
  exposeGetter: boolean;
};

const createStorageInfo = ({
  type,
  namespace,
  storage,
  exposeGetter,
}: StorageInfoOptions): NFOrchestratorStorageInfo => {
  const info: NFOrchestratorStorageInfo = {
    version: ORCHESTRATOR_VERSION,
    type,
    namespace,
    keys: KEYS,
  };
  if (!exposeGetter) return Object.freeze(info);

  return Object.freeze({
    ...info,
    // Cloned again because custom storages may hand out live references.
    get: (key: string) =>
      isStorageKey(key) ? cloneEntry(key, storage(key, undefined).get()) : undefined,
  });
};

// Replaced (not mutated) so earlier namespaces survive while the published object stays frozen.
// Diagnostic only: a locked-down or foreign global must never break init, so failures are swallowed.
export const publishStorageInfo = (options: StorageInfoOptions): void => {
  try {
    globalThis.__NF_ORCHESTRATOR__ = Object.freeze<NFOrchestratorGlobal>({
      storage: Object.freeze({
        ...globalThis.__NF_ORCHESTRATOR__?.storage,
        [options.namespace]: createStorageInfo(options),
      }),
    });
  } catch {
    /* the global is not writable */
  }
};
