import type { SharedExternal, SharedVersion, SharedVersionMeta } from 'lib/core/1.domain';
import { mergeRows, redirectRow } from 'lib/core/1.domain/externals/rows';
import type { AcceptsTag, VersionAcceptance } from 'lib/core/1.domain/externals/compatibility';
import { NFError } from 'lib/core/native-federation.error';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';

// Fails init for a strict copy whose range rejects what is shared at `servedAt`; both are `name@tag`.
export function rejectIncompatible(
  config: LoggingConfig,
  copy: SharedVersionMeta,
  rejected: string,
  servedAt: string
): never {
  config.log.error(
    3,
    `[${copy.name}][${rejected}] Is not compatible with requiredRange '${copy.requiredVersion}' of shared ${servedAt}.`
  );
  throw new NFError(`External ${rejected} could not be shared.`);
}

/**
 * The tail of winner election: derive every other version's verdict from the chosen one, clear `dirty`.
 * `determine` is the only caller, and passes its `acceptsTag` plus the `acceptance` it already built for
 * the election.
 */
export function createApplyWinner(config: LoggingConfig & ModeConfig) {
  return function applyWinner(
    externalName: string,
    external: SharedExternal,
    winner: SharedVersion,
    acceptsTag: AcceptsTag,
    acceptance: VersionAcceptance
  ): SharedExternal {
    // Every copy accepts its own tag, so a lone version, like the winner, is never redirected or split.
    if (external.versions.length > 1) {
      const rebuilt: SharedVersion[] = [];

      for (const v of external.versions) {
        const objector =
          config.strict.strictExternalCompatibility && acceptance.objector(v, winner.tag);

        if (objector)
          rejectIncompatible(
            config,
            objector,
            `${externalName}@${v.tag}`,
            `${externalName}@${winner.tag}`
          );

        rebuilt.push(...redirectRow(v, winner.tag, acceptsTag));
      }

      // One row per (tag, action), which the record keeps: a warm record can already hold a `scope` row at
      // the tag a split produces. Merged after the loop, not during it: a row's verdict is not final until
      // the winner has been applied to it. The winner absorbs its tag's other rows, or the `share` below
      // would land on a row merged away.
      external.versions = mergeRows(rebuilt, winner);
    }

    winner.action = 'share';

    external.dirty = false;
    return external;
  };
}
