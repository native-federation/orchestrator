import type { StorageKey, StorageType } from './storage.contract';

type NFOrchestratorStorageInfo = Readonly<{
  version: string;
  type: StorageType;
  namespace: string;
  keys: readonly StorageKey[];
  // Returns a copy of the committed value, undefined for unknown keys. Absent when the host opted out.
  get?: (key: string) => unknown;
}>;

type NFOrchestratorGlobal = Readonly<{
  storage: Readonly<Record<string, NFOrchestratorStorageInfo>>;
}>;

declare global {
  var __NF_ORCHESTRATOR__: NFOrchestratorGlobal | undefined;
}

export { NFOrchestratorGlobal, NFOrchestratorStorageInfo };
