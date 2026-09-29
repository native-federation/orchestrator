import type { StorageType } from './storage.contract';

type NFOrchestratorStorageInfo = Readonly<{
  type: StorageType;
  namespace: string;
  keys: readonly string[];
}>;

type NFOrchestratorGlobal = Readonly<{
  version: string;
  storage: Readonly<Record<string, NFOrchestratorStorageInfo>>;
}>;

declare global {
  var __NF_ORCHESTRATOR__: NFOrchestratorGlobal | undefined;
}

export { NFOrchestratorGlobal, NFOrchestratorStorageInfo };
