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
 * The scopes either pooling step has anything to do in. With auto-pooling off only a scope that carries a
 * `pool` tag of its own can pool anything, and a pool never spans share scopes — so one tag must not put
 * every other scope through a graph build. Auto-pooling on must never early-out, since any scoped package is
 * potentially poolable. The `strict` scope is never pooled.
 *
 * Names only, so a caller that decides to skip a scope never reads it out of storage.
 */
export function poolableScopes(
  config: ModeConfig,
  repo: Pick<ForSharedExternalsStorage, 'getScopes' | 'scopeType' | 'hasPoolTag'>
): { useAutoExternalPooling: boolean; scopes: string[] } {
  const { useAutoExternalPooling } = config.feature;

  return {
    useAutoExternalPooling,
    scopes: repo
      .getScopes()
      .filter(
        scope =>
          repo.scopeType(scope) !== 'strict' && (useAutoExternalPooling || repo.hasPoolTag(scope))
      ),
  };
}
