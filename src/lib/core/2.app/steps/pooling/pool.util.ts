import type { ExternalName, RemoteName, shareScope } from 'lib/core/1.domain';
import type { ForSharedExternalsStorage } from '../../driving-ports/for-shared-externals-storage.port';
import type { PoolMember, PoolName } from './pool.types';

// A projection built at most once, and only if a gate gets far enough to ask for it. Both pooling steps
// iterate to a fixed point over views that do not change between rounds.
export function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

export function remotesInPool(members: PoolMember[]): RemoteName[] {
  return [
    ...new Set(members.flatMap(m => m.external.versions.flatMap(v => v.remotes.map(r => r.name)))),
  ];
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

/**
 * Write `poolName` onto every external of the scope that is in a pool under a different name, and clear it —
 * with every copy's `poolCause` — off one that is in none any more. Names are per scope (a suffix
 * disambiguates two pools sharing a tag), so a pool nobody re-elected can still be renamed by another.
 * `skip` names pools whose members the caller is rebuilding itself.
 */
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

    // A fresh record rather than a mutation: the dynamic path must leave committed versions untouched.
    const { poolName: _stale, ...rest } = external;
    repo.addOrUpdate(
      name,
      pool !== undefined
        ? { ...rest, poolName: pool }
        : {
            ...rest,
            versions: external.versions.map(v => ({
              ...v,
              remotes: v.remotes.map(({ poolCause: _cause, ...meta }) => meta),
            })),
          },
      scope
    );
  }
}
