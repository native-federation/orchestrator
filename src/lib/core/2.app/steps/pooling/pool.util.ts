import type { shareScope } from 'lib/core/1.domain';
import type { ForSharedExternalsStorage } from '../../driving-ports/for-shared-externals-storage.port';
import { scopeHasPoolState } from 'lib/core/1.domain/pooling/pool-state';
import type { PoolMember, PoolName } from 'lib/core/1.domain/pooling/membership';

export function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

// A pool never spans share scopes, so one tag must not put every other scope through a graph build.
export function poolableScopes(
  repo: Pick<ForSharedExternalsStorage, 'getScopes' | 'scopeType' | 'getFromScope'>,
  only: (scope: string) => boolean = () => true
): [scope: string, sharedExternals: shareScope][] {
  const poolable: [string, shareScope][] = [];
  for (const scope of repo.getScopes()) {
    if (repo.scopeType(scope) === 'strict' || !only(scope)) continue;
    const sharedExternals = repo.getFromScope(scope);
    if (scopeHasPoolState(sharedExternals)) poolable.push([scope, sharedExternals]);
  }
  return poolable;
}

// Writes each pool member's current `poolName`; a pool nobody re-elected can still be renamed by another.
// An external in no pool keeps what it stored: mark-pools strips it and re-elects it at the next init, and
// spreads dirty by that stored name first. `skip` names pools the caller rebuilds itself.
export function writePoolNames(
  sharedExternals: shareScope,
  pools: Map<PoolName, PoolMember[]>,
  repo: Pick<ForSharedExternalsStorage, 'addOrUpdate'>,
  scope: string,
  skip: ReadonlySet<PoolName> = new Set()
): void {
  for (const [poolName, members] of pools) {
    if (skip.has(poolName)) continue;
    for (const { name } of members) {
      const external = sharedExternals[name]!;
      if (external.poolName !== poolName) repo.addOrUpdate(name, { ...external, poolName }, scope);
    }
  }
}
