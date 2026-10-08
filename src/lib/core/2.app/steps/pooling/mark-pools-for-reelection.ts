import type { ForMarkingPoolsForReelection } from '../../driver-ports/init/for-marking-pools-for-reelection.port';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { ModeConfig } from '../../config/mode.contract';
import { hasPoolResults, withoutPoolResults } from 'lib/core/1.domain/pooling/pool-state';
import { buildPools } from 'lib/core/1.domain/pooling/membership';
import { reelectedNames } from 'lib/core/1.domain/pooling/reelection';
import { poolableScopes } from './pool.util';

export function createMarkPoolsForReelection(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo'>
): ForMarkingPoolsForReelection {
  // A pool is one unit of state: any dirty member re-elects it whole. An external in no pool any more loses
  // its pool results here, since pooling never visits it. See docs/version-resolver.md §"How the verdicts
  // land in the record and the map".
  return () => {
    for (const [scope, sharedExternals] of poolableScopes(ports.sharedExternalsRepo)) {
      // Nothing dirty in the scope ⇒ no pool has a dirty member ⇒ nothing to spread, so skip before
      // building the graph. Measured, this was the whole pooling cost of a warm init.
      if (!Object.values(sharedExternals).some(external => external.dirty)) continue;

      let spread = 0;
      let unpooled = 0;
      const { pools } = buildPools(sharedExternals);
      const pooled = new Set<string>();
      for (const members of pools.values()) for (const member of members) pooled.add(member.name);

      // Mutates the stored records in place; nothing is written, so a scope with nothing dirty stays
      // untouched and `commit()` has no reason to fire.
      for (const name of reelectedNames(sharedExternals, pools)) {
        const external = sharedExternals[name]!;
        if (external.dirty) continue;
        external.dirty = true;
        if (pooled.has(name)) spread++;
      }

      for (const [name, external] of Object.entries(sharedExternals)) {
        if (pooled.has(name) || !hasPoolResults(external)) continue;
        const cleared = withoutPoolResults(external);
        for (const key of Object.keys(external))
          if (!(key in cleared)) Reflect.deleteProperty(external, key);
        Object.assign(external, cleared, { dirty: true });
        unpooled++;
      }

      if (spread > 0)
        config.log.debug(3, `[${scope}] ${spread} pool member(s) marked dirty for re-election.`);
      if (unpooled > 0)
        config.log.debug(
          3,
          `[${scope}] ${unpooled} external(s) left every pool; cleared their pool state for re-election.`
        );
    }

    return Promise.resolve();
  };
}
