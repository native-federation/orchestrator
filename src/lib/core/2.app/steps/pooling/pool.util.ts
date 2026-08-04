import type { RemoteName } from 'lib/core/1.domain';
import type { ForSharedExternalsStorage } from '../../driving-ports/for-shared-externals-storage.port';
import type { ModeConfig } from '../../config/mode.contract';
import type { PoolMember } from './pool.types';

export function remotesInPool(members: PoolMember[]): RemoteName[] {
  return [
    ...new Set(members.flatMap(m => m.external.versions.flatMap(v => v.remotes.map(r => r.name)))),
  ];
}

/**
 * The scopes either pooling step has anything to do in. With auto-pooling off and no `pool` tag anywhere
 * nothing can be pooled at all, and the scope walk is skipped; auto-pooling on must never early-out, since
 * any scoped package is potentially poolable. The `strict` scope is never pooled.
 *
 * Names only, so a caller that decides to skip a scope never reads it out of storage.
 */
export function poolableScopes(
  config: ModeConfig,
  repo: Pick<ForSharedExternalsStorage, 'getScopes' | 'scopeType' | 'hasPoolTag'>
): { useAutoExternalPooling: boolean; scopes: string[] } {
  const { useAutoExternalPooling } = config.feature;
  if (!useAutoExternalPooling && !repo.hasPoolTag()) return { useAutoExternalPooling, scopes: [] };

  return {
    useAutoExternalPooling,
    scopes: repo.getScopes().filter(scope => repo.scopeType(scope) !== 'strict'),
  };
}
