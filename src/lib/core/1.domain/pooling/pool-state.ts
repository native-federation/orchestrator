import type { DeepReadonly } from 'lib/utils/deep-readonly';
import type { ExternalName, SharedExternal, shareScope } from '../externals/external.contract';
import type { PoolMember, PoolName } from './membership';

// What pooling writes onto a record: `poolName`, `poolWinner`, and `servedBy`/`poolCause` per copy. Outside a
// pool all of it is stale. The declared `pool` label is pooling's input, not a result, and always stays.
export function hasPoolResults(external: DeepReadonly<SharedExternal>): boolean {
  if (external.poolName !== undefined || external.poolWinner !== undefined) return true;
  return external.versions.some(v =>
    v.remotes.some(r => r.servedBy !== undefined || r.poolCause !== undefined)
  );
}

// A fresh record; the input is left untouched.
export function withoutPoolResults(external: DeepReadonly<SharedExternal>): SharedExternal {
  const { poolName: _poolName, poolWinner: _poolWinner, ...rest } = external;
  return {
    ...rest,
    versions: external.versions.map(v => ({
      ...v,
      remotes: v.remotes.map(({ servedBy: _servedBy, poolCause: _poolCause, ...meta }) => meta),
    })),
  };
}

// Stored results outlive the last label that left, so they count; read from the record, not this init.
export function scopeHasPoolState(scope: DeepReadonly<shareScope>): boolean {
  for (const name in scope) {
    const external = scope[name]!;
    if (hasPoolResults(external)) return true;
    for (const version of external.versions)
      for (const remote of version.remotes) if (remote.pool?.trim()) return true;
  }
  return false;
}

// The record of every member whose stored `poolName` is not its pool's, under the new name, pool results
// kept: a pool nobody re-elected can still be renamed by another. An external in no pool keeps its stored
// name until the next dirty init strips it.
export function renamedRecords(
  scope: shareScope,
  pools: ReadonlyMap<PoolName, readonly PoolMember[]>
): [ExternalName, SharedExternal][] {
  const renamed: [ExternalName, SharedExternal][] = [];
  for (const [poolName, members] of pools)
    for (const { name } of members)
      if (scope[name]!.poolName !== poolName) renamed.push([name, { ...scope[name]!, poolName }]);
  return renamed;
}
