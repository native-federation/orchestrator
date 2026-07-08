import type { RemoteName, SharedExternal, shareScope } from 'lib/core/1.domain';
import type { Optional } from 'lib/utils/optional';

export type ForSharedExternalsStorage = {
  tryGet: (external: string, shareScope?: string) => Optional<SharedExternal>;
  getFromScope: (shareScope?: string) => shareScope;
  getScopes: (o?: { includeGlobal: boolean }) => string[];
  scopeType: (shareScope?: string) => 'global' | 'strict' | 'shareScope';
  removeFromAllScopes: (remoteName: RemoteName) => void;
  addOrUpdate: (
    name: string,
    external: SharedExternal,
    shareScope?: string
  ) => ForSharedExternalsStorage;
  /**
   * Record that a remote declared a `pool` tag on some external. Set once while remote entries
   * are stored (where each tag is already read), it memoizes the observation so the pooling step
   * can early-out without re-walking every external — see `pool-shared-externals`.
   */
  markPoolTagSeen: () => void;
  /** Whether any remote declared a `pool` tag during entry storage. */
  hasSeenPoolTag: () => boolean;
  commit: () => ForSharedExternalsStorage;
};
