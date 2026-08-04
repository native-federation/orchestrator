import type { ForMarkingPoolsForReelection } from '../../driver-ports/init/for-marking-pools-for-reelection.port';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { ModeConfig } from '../../config/mode.contract';
import { buildPools } from './pool-graph';
import { poolableScopes } from './pool.util';

export function createMarkPoolsForReelection(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo'>
): ForMarkingPoolsForReelection {
  /**
   * Runs between process-remote-entries and determine-shared-externals: a pool is one unit of state, so
   * whenever any member is dirty every member is marked dirty and `determine` re-elects the pool whole.
   *
   * Without this, pooling reads back its own `scope` verdicts for members no remote touched this init and
   * gate 1 cannot tell them from a range violation `determine` just found. See
   * docs/version-resolver.md §"How pooling resolves".
   */
  return () => {
    const { useAutoExternalPooling, scopes } = poolableScopes(config, ports.sharedExternalsRepo);

    for (const scope of scopes) {
      const sharedExternals = ports.sharedExternalsRepo.getFromScope(scope);

      // Nothing dirty in the scope ⇒ no pool has a dirty member ⇒ nothing to spread, so skip before
      // building the graph. Measured, this was the whole pooling cost of a warm init.
      if (!Object.values(sharedExternals).some(external => external.dirty)) continue;

      let spread = 0;

      // Mutates the stored records in place; nothing is written, so a scope with nothing dirty stays
      // untouched and `commit()` has no reason to fire.
      for (const [, members] of buildPools(sharedExternals, useAutoExternalPooling)) {
        if (!members.some(m => m.external.dirty)) continue;
        for (const member of members)
          if (!member.external.dirty) {
            member.external.dirty = true;
            spread++;
          }
      }

      if (spread > 0)
        config.log.debug(3, `[${scope}] ${spread} pool member(s) marked dirty for re-election.`);
    }

    return Promise.resolve();
  };
}
