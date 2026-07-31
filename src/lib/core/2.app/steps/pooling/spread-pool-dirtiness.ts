import type { ForSpreadingPoolDirtiness } from '../../driver-ports/init/for-spreading-pool-dirtiness.port';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { ModeConfig } from '../../config/mode.contract';
import { buildPools } from './pool-graph';

export function createSpreadPoolDirtiness(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo'>
): ForSpreadingPoolDirtiness {
  /**
   * Runs between process-remote-entries and determine-shared-externals: a pool is one unit of state, so
   * whenever any member is dirty every member is marked dirty, and `determine` re-elects the pool whole.
   *
   * Without this, pooling reads back its own `scope` verdicts for members no remote touched this init and
   * gate 1 cannot tell them from a range violation `determine` just found. With it, pooling runs on a pool
   * exactly when every member of that pool was re-elected, so every `scope` it reads is `determine`'s and
   * describes the current portfolio. See docs/version-resolver.md §"How pooling resolves".
   *
   * Costs nothing when nothing changed: a plain reload has no dirty external, so no pool is expanded and
   * no external is re-elected. Bounded above by one cold election of the pools something changed in.
   */
  return () => {
    const { useAutoExternalPooling } = config.feature;

    if (!useAutoExternalPooling && !ports.sharedExternalsRepo.hasPoolTag()) {
      return Promise.resolve();
    }

    for (const scope of ports.sharedExternalsRepo.getScopes()) {
      if (ports.sharedExternalsRepo.scopeType(scope) === 'strict') continue;

      const sharedExternals = ports.sharedExternalsRepo.getFromScope(scope);
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
