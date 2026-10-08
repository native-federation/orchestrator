import type { ExternalName, shareScope } from 'lib/core/1.domain';
import type { PoolMember, PoolName } from './membership';

// Every external a dirty one drags into re-election: dirty spreads over the computed pools and the stored
// `poolName`s together, transitively, so a pool that split or merged since it was stored is re-elected on
// every side; the stored names must be read before anything clears them.
export function reelectedNames(
  scope: shareScope,
  pools: ReadonlyMap<PoolName, readonly PoolMember[]>
): Set<ExternalName> {
  const byStored = new Map<PoolName, ExternalName[]>();
  for (const [name, external] of Object.entries(scope)) {
    if (external.poolName === undefined) continue;
    const siblings = byStored.get(external.poolName);
    if (siblings) siblings.push(name);
    else byStored.set(external.poolName, [name]);
  }
  const byComputed = new Map<ExternalName, readonly PoolMember[]>();
  for (const members of pools.values())
    for (const member of members) byComputed.set(member.name, members);

  const reached = new Set<ExternalName>();
  const pending: ExternalName[] = [];
  const reach = (name: ExternalName) => {
    if (reached.has(name)) return;
    reached.add(name);
    pending.push(name);
  };
  for (const [name, external] of Object.entries(scope)) if (external.dirty) reach(name);

  const spreadStored = new Set<PoolName>();
  const spreadComputed = new Set<readonly PoolMember[]>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    const stored = scope[name]!.poolName;
    if (stored !== undefined && !spreadStored.has(stored)) {
      spreadStored.add(stored);
      byStored.get(stored)!.forEach(reach);
    }
    const pool = byComputed.get(name);
    if (pool !== undefined && !spreadComputed.has(pool)) {
      spreadComputed.add(pool);
      for (const member of pool) reach(member.name);
    }
  }
  return reached;
}
