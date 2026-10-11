import type { ExternalName, SharedExternal, shareScope } from '../externals/external.contract';
import { buildPools, type PoolMember, type PoolName } from './membership';
import { hasPoolResults, scopeHasPoolState, withoutPoolResults } from './pool-state';
import type { DeepReadonly } from 'lib/utils/deep-readonly';

export type ElectionPlan = {
  pools: Map<PoolName, PoolMember[]>;
  // Dirty so determine re-elects them.
  stripped: Map<ExternalName, SharedExternal>;
  labelledAlone: ExternalName[];
};

// Any dirty external re-elects every pool of its scope.
// See docs/version-resolver.md §"How the verdicts land in the record and the map".
export function planElection(scope: DeepReadonly<shareScope>, poolable: boolean): ElectionPlan {
  // Skip before building the graph: measured, that was the whole pooling cost of a warm init.
  if (
    !poolable ||
    !Object.values(scope).some(external => external.dirty) ||
    !scopeHasPoolState(scope)
  )
    return { pools: new Map(), stripped: new Map(), labelledAlone: [] };

  const { pools, labelledAlone } = buildPools(scope);
  const pooled = new Set([...pools.values()].flatMap(members => members.map(m => m.name)));
  const stripped = new Map<ExternalName, SharedExternal>();
  for (const [name, external] of Object.entries(scope))
    if (!pooled.has(name) && hasPoolResults(external))
      stripped.set(name, { ...withoutPoolResults(external), dirty: true });
  return { pools, stripped, labelledAlone };
}
