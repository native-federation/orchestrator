import type { ExternalName, shareScope } from 'lib/core/1.domain';
import type { ForSharedExternalsStorage } from '../../driving-ports/for-shared-externals-storage.port';
import { withoutPoolResults } from 'lib/core/1.domain/pooling/pool-state';
import type { PoolMember, PoolName } from './pool.types';

// A projection built at most once, and only if the decision gets far enough to ask for it.
export function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

/**
 * The scopes either pooling step has anything to do in. A pool never spans share scopes, so one tag must
 * not put every other scope through a graph build. The `strict` scope is never pooled.
 *
 * Names only, so a caller that decides to skip a scope never reads it out of storage.
 */
export function poolableScopes(
  repo: Pick<ForSharedExternalsStorage, 'getScopes' | 'scopeType' | 'hasPoolState'>
): string[] {
  return repo
    .getScopes()
    .filter(scope => repo.scopeType(scope) !== 'strict' && repo.hasPoolState(scope));
}

// Writes each external's current `poolName`, and clears every pool result off one in no pool any more;
// a pool nobody re-elected can still be renamed by another. `skip` names pools the caller rebuilds itself.
export function syncPoolNames(
  sharedExternals: shareScope,
  pools: Map<PoolName, PoolMember[]>,
  repo: Pick<ForSharedExternalsStorage, 'addOrUpdate'>,
  scope: string,
  skip: ReadonlySet<PoolName> = new Set()
): void {
  const named = new Map<ExternalName, PoolName>();
  for (const [name, members] of pools) for (const member of members) named.set(member.name, name);

  for (const [name, external] of Object.entries(sharedExternals)) {
    const pool = named.get(name);
    if (pool !== undefined && skip.has(pool)) continue;
    if (external.poolName === pool) continue;

    repo.addOrUpdate(
      name,
      pool !== undefined ? { ...external, poolName: pool } : withoutPoolResults(external),
      scope
    );
  }
}
