import type { ExternalName, SharedExternal, shareScope } from '../externals/external.contract';
import { buildPools, type PoolMember, type PoolName } from './membership';
import { hasPoolResults, scopeHasPoolState, withoutPoolResults } from './pool-state';
import type { DeepReadonly } from 'lib/utils/deep-readonly';

export type ElectionPlan = {
  pools: Map<PoolName, PoolMember[]>;
  // Externals in no pool that still carry pool results, stripped and dirty so determine re-elects them.
  dissolved: Map<ExternalName, SharedExternal>;
  labelledAlone: ExternalName[];
};

// Reads the scope, never writes it. Any dirty external re-elects every pool of its scope. See
// docs/version-resolver.md §"How the verdicts land in the record and the map".
export function planElection(scope: DeepReadonly<shareScope>, poolable: boolean): ElectionPlan {
  // Nothing dirty ⇒ nothing to re-elect, so skip before building the graph. Measured, this was the whole
  // pooling cost of a warm init.
  if (
    !poolable ||
    !Object.values(scope).some(external => external.dirty) ||
    !scopeHasPoolState(scope)
  )
    return { pools: new Map(), dissolved: new Map(), labelledAlone: [] };

  const { pools, labelledAlone } = buildPools(scope);
  const pooled = new Set([...pools.values()].flatMap(members => members.map(m => m.name)));
  const dissolved = new Map<ExternalName, SharedExternal>();
  for (const [name, external] of Object.entries(scope))
    if (!pooled.has(name) && hasPoolResults(external))
      dissolved.set(name, { ...withoutPoolResults(external), dirty: true });
  return { pools, dissolved, labelledAlone };
}

// Every member whose stored `poolName` is not its pool's: a pool nobody re-elected can still be renamed by
// another. Each member must be a key of `scope`. An external in no pool keeps its stored name until the next
// dirty init strips it.
export function renamesOf(
  scope: DeepReadonly<shareScope>,
  pools: ReadonlyMap<PoolName, readonly PoolMember[]>
): [ExternalName, PoolName][] {
  const renames: [ExternalName, PoolName][] = [];
  for (const [poolName, members] of pools)
    for (const { name } of members)
      if (scope[name]!.poolName !== poolName) renames.push([name, poolName]);
  return renames;
}

// The record of each renamed member under its new pool name, pool results kept: its pool was not re-elected.
export function renamedRecords(
  scope: shareScope,
  renames: readonly [ExternalName, PoolName][]
): [ExternalName, SharedExternal][] {
  return renames.map(([name, poolName]) => [name, { ...scope[name]!, poolName }]);
}
