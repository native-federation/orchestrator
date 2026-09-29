import type { NFOrchestratorGlobal } from 'lib/core/2.app/config/orchestrator-global.contract';
import {
  STORAGE_KEYS,
  type StorageEntryHandler,
  type StorageType,
} from 'lib/core/2.app/config/storage.contract';
import { cloneEntry } from 'lib/utils/clone-entry';

// Injected by build.js; bundles built without that define (e.g. the e2e harness) report 'dev'.
declare const __NF_ORCHESTRATOR_VERSION__: string | undefined;
const VERSION =
  typeof __NF_ORCHESTRATOR_VERSION__ === 'string' ? __NF_ORCHESTRATOR_VERSION__ : 'dev';

const KEYS: readonly string[] = Object.freeze(Object.values(STORAGE_KEYS));

// Replaced (not mutated) so earlier namespaces survive while the published object stays frozen.
export const publishStorageInfo = (
  type: StorageType,
  namespace: string,
  storage: StorageEntryHandler
): void => {
  globalThis.__NF_ORCHESTRATOR__ = Object.freeze<NFOrchestratorGlobal>({
    version: VERSION,
    storage: Object.freeze({
      ...globalThis.__NF_ORCHESTRATOR__?.storage,
      [namespace]: Object.freeze({
        type,
        namespace,
        keys: KEYS,
        // Cloned again because custom storages may hand out live references.
        get: (key: string) =>
          KEYS.includes(key) ? cloneEntry(key, storage(key, undefined).get()) : undefined,
      }),
    }),
  });
};
