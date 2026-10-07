import type {
  ForMarkingPoolsForReelection,
  PooledExternals,
} from '../../driver-ports/init/for-marking-pools-for-reelection.port';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { ModeConfig } from '../../config/mode.contract';
import type { ExternalName } from 'lib/core/1.domain';
import { hasPoolResults, withoutPoolResults } from 'lib/core/1.domain/pooling/pool-state';
import { buildPools } from 'lib/core/1.domain/pooling/membership';
import { poolableScopes } from './pool.util';

export function createMarkPoolsForReelection(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo'>
): ForMarkingPoolsForReelection {
  /**
   * Runs between process-remote-entries and determine-shared-externals: a pool is one unit of state, so
   * whenever any member is dirty every member is marked dirty and the pool is elected whole.
   *
   * Without this, a member no remote touched this init keeps the previous election's verdict beside the
   * new one. See docs/version-resolver.md §"How the verdicts land in the record and the map".
   *
   * An external in no pool any more loses what pooling stored on it, and is re-elected. It has to happen
   * here rather than in pooling, which never visits it: a stale `servedBy` keeps the map pointing its copy
   * at a build nothing chose, and `determine` already exempts such a copy from the coverage policy.
   */
  return () => {
    const reelected = new Map<string, Set<ExternalName>>();
    for (const [scope, sharedExternals] of poolableScopes(ports.sharedExternalsRepo)) {
      // Nothing dirty in the scope ⇒ no pool has a dirty member ⇒ nothing to spread, so skip before
      // building the graph. Measured, this was the whole pooling cost of a warm init.
      if (!Object.values(sharedExternals).some(external => external.dirty)) continue;

      let spread = 0;
      let unpooled = 0;
      const pooled = new Set<string>();

      // Mutates the stored records in place; nothing is written, so a scope with nothing dirty stays
      // untouched and `commit()` has no reason to fire.
      for (const [, members] of buildPools(sharedExternals).pools) {
        for (const member of members) pooled.add(member.name);
        if (!members.some(m => m.external.dirty)) continue;
        let names = reelected.get(scope);
        if (!names) reelected.set(scope, (names = new Set()));
        for (const member of members) names.add(member.name);
        for (const member of members)
          if (!member.external.dirty) {
            member.external.dirty = true;
            spread++;
          }
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

    return Promise.resolve<PooledExternals>(reelected);
  };
}
