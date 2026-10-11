import type { DeepReadonly } from 'lib/utils/deep-readonly';
import type { SharedExternal, shareScope } from '../externals/external.contract';

// Outside a pool, pool results are stale. The declared `pool` label is pooling's input, not a result, and
// always stays.
export function hasPoolResults(external: DeepReadonly<SharedExternal>): boolean {
  if (external.poolName !== undefined || external.poolWinner !== undefined) return true;
  return external.versions.some(v =>
    v.remotes.some(r => r.servedBy !== undefined || r.poolCause !== undefined)
  );
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
