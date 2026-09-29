import type { NFOrchestratorGlobal } from 'lib/core/2.app/config/orchestrator-global.contract';
import { STORAGE_KEYS, type StorageEntryCreator } from 'lib/core/2.app/config/storage.contract';

// Injected by build.js; bundles built without that define (e.g. the e2e harness) report 'dev'.
declare const __NF_ORCHESTRATOR_VERSION__: string | undefined;
const VERSION =
  typeof __NF_ORCHESTRATOR_VERSION__ === 'string' ? __NF_ORCHESTRATOR_VERSION__ : 'dev';

// Replaced (not mutated) so earlier namespaces survive while the published object stays frozen.
export const publishStorageInfo = (creator: StorageEntryCreator, namespace: string): void => {
  globalThis.__NF_ORCHESTRATOR__ = Object.freeze<NFOrchestratorGlobal>({
    version: VERSION,
    storage: Object.freeze({
      ...globalThis.__NF_ORCHESTRATOR__?.storage,
      [namespace]: Object.freeze({
        type: creator.type ?? 'custom',
        namespace,
        keys: Object.freeze(Object.values(STORAGE_KEYS)),
      }),
    }),
  });
};
