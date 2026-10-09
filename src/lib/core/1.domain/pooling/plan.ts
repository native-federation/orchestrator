import type { ExternalName, SharedExternal, shareScope } from '../externals/external.contract';
import { buildPools, type PoolMember, type PoolName } from './membership';
import { hasPoolResults, scopeHasPoolState, withoutPoolResults } from './pool-state';
import { reelectedNames } from './reelection';

export type ElectionPlan = {
  dirtyPools: Map<PoolName, PoolMember[]>;
  // Externals in no pool that still carry pool results, stripped and dirty so determine re-elects them.
  dissolved: Map<ExternalName, SharedExternal>;
  // Members of a pool nobody re-elects whose stored `poolName` is not the computed one.
  renames: [ExternalName, PoolName][];
  labelledAlone: ExternalName[];
};

// Reads the scope, never writes it. A pool is one unit of state: any dirty member re-elects it whole. See
// docs/version-resolver.md §"How the verdicts land in the record and the map".
export function planElection(scope: shareScope, poolable: boolean): ElectionPlan {
  const plan: ElectionPlan = {
    dirtyPools: new Map(),
    dissolved: new Map(),
    renames: [],
    labelledAlone: [],
  };
  // Nothing dirty ⇒ nothing to re-elect, so skip before building the graph. Measured, this was the whole
  // pooling cost of a warm init.
  if (!poolable || !Object.values(scope).some(external => external.dirty)) return plan;
  if (!scopeHasPoolState(scope)) return plan;

  const { pools, labelledAlone } = buildPools(scope);
  plan.labelledAlone = labelledAlone;
  const reelected = reelectedNames(scope, pools);
  const pooled = new Set<ExternalName>();
  const clean = new Map<PoolName, PoolMember[]>();
  for (const [poolName, members] of pools) {
    for (const { name } of members) pooled.add(name);
    if (members.some(m => reelected.has(m.name))) plan.dirtyPools.set(poolName, members);
    else clean.set(poolName, members);
  }
  plan.renames = renamesOf(scope, clean);

  for (const [name, external] of Object.entries(scope))
    if (!pooled.has(name) && hasPoolResults(external))
      plan.dissolved.set(name, { ...withoutPoolResults(external), dirty: true });
  return plan;
}

// Every member whose stored `poolName` is not its pool's: a pool nobody re-elected can still be renamed by
// another. Each member must be a key of `scope`. An external in no pool keeps its stored name, which the next
// init's plan spreads dirty by before it strips it.
export function renamesOf(
  scope: shareScope,
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
