import type { RemoteName, SharedExternal, shareScope } from 'lib/core/1.domain';
import type { Optional } from 'lib/utils/optional';

export type ForSharedExternalsStorage = {
  tryGet: (external: string, shareScope?: string) => Optional<SharedExternal>;
  getFromScope: (shareScope?: string) => shareScope;
  getScopes: (o?: { includeGlobal: boolean }) => string[];
  scopeType: (shareScope?: string) => 'global' | 'strict' | 'shareScope';
  removeFromAllScopes: (remoteNames: ReadonlySet<RemoteName>) => void;
  addOrUpdate: (
    name: string,
    external: SharedExternal,
    shareScope?: string
  ) => ForSharedExternalsStorage;
  // The scopes written since the last commit or rollback. Exact only while every write goes through `addOrUpdate`
  // or `removeFromAllScopes`: an external edited in place and never written back marks nothing.
  uncommittedScopes: () => string[];
  // The scopes a runtime load wrote since the serving builds were last decided in them. Stored, so the next
  // page's init decides them again.
  markUndecided: (shareScope: string) => void;
  isUndecided: (shareScope: string) => boolean;
  markDecided: (shareScope: string) => void;
  commit: () => ForSharedExternalsStorage;
  rollback: () => ForSharedExternalsStorage;
};
