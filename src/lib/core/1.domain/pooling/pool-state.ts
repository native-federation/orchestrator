import type { SharedExternal, shareScope } from '../externals/external.contract';

// What pooling writes onto a record: `poolName`, `poolWinner`, and `servedBy`/`poolCause` per copy. Outside a
// pool all of it is stale. The declared `pool` tag is pooling's input, not a result, and always stays.
export function hasPoolResults(external: SharedExternal): boolean {
  if (external.poolName !== undefined || external.poolWinner !== undefined) return true;
  return external.versions.some(v =>
    v.remotes.some(r => r.servedBy !== undefined || r.poolCause !== undefined)
  );
}

// A fresh record: the dynamic path must leave committed versions untouched.
export function withoutPoolResults(external: SharedExternal): SharedExternal {
  const { poolName: _poolName, poolWinner: _poolWinner, ...rest } = external;
  return {
    ...rest,
    versions: external.versions.map(v => ({
      ...v,
      remotes: v.remotes.map(({ servedBy: _servedBy, poolCause: _poolCause, ...meta }) => meta),
    })),
  };
}

// Stored results outlive the last tag that left, so they count; read from the record, not this init.
export function scopeHasPoolState(scope: shareScope): boolean {
  for (const name in scope) {
    const external = scope[name]!;
    if (hasPoolResults(external)) return true;
    for (const version of external.versions)
      for (const remote of version.remotes) if (remote.pool?.trim()) return true;
  }
  return false;
}
