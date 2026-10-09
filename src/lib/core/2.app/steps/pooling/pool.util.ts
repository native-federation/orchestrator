import type { ExternalName, shareScope } from 'lib/core/1.domain';
import type { ForSharedExternalsStorage } from '../../driving-ports/for-shared-externals-storage.port';
import type { PoolName } from 'lib/core/1.domain/pooling/membership';

export function writePoolNames(
  sharedExternals: shareScope,
  renames: readonly [ExternalName, PoolName][],
  repo: Pick<ForSharedExternalsStorage, 'addOrUpdate'>,
  scope: string
): void {
  for (const [name, poolName] of renames)
    repo.addOrUpdate(name, { ...sharedExternals[name]!, poolName }, scope);
}
