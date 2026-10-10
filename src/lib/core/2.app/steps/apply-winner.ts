import type { SharedExternal, SharedVersion, SharedVersionMeta } from 'lib/core/1.domain';
import { uncoveredEntrypoints, versionEntries } from 'lib/core/1.domain/externals/basis';
import { mergeRows, rowAt } from 'lib/core/1.domain/externals/rows';
import type { AcceptsTag, VersionAcceptance } from 'lib/core/1.domain/externals/compatibility';
import { NFError } from 'lib/core/native-federation.error';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';

/**
 * The tail of winner election: derive every other version's verdict from the chosen one, apply the
 * entrypoint coverage policy, clear `dirty`. `determine` is the only caller, and passes its
 * `acceptsTag` plus the `acceptance` it already built for the election.
 *
 * A hazard for anyone who ever adds a second caller that re-points a winner: `findTears` keys off the
 * winner's merged entries, so moving the winner moves the surface coverage is measured against.
 */
export function createApplyWinner(config: LoggingConfig & ModeConfig) {
  return function applyWinner(
    externalName: string,
    external: SharedExternal,
    winner: SharedVersion,
    acceptsTag: AcceptsTag,
    acceptance?: VersionAcceptance
  ): SharedExternal {
    // Every copy accepts its own tag, so a lone version, like the winner, is never redirected or split.
    if (external.versions.length > 1) {
      const { accepts, objector } = acceptance!;

      const rebuilt: SharedVersion[] = [];

      for (const v of external.versions) {
        rebuilt.push(v);

        if (accepts(v, winner.tag)) {
          v.action = 'skip';
          continue;
        }

        const strict = objector(v, winner.tag);

        if (config.strict.strictExternalCompatibility && strict) {
          config.log.error(
            3,
            `[${strict.name}][${externalName}@${v.tag}] Is not compatible with requiredRange '${strict.requiredVersion}' of shared ${externalName}@${winner.tag}.`
          );

          throw new NFError(`External ${externalName}@${v.tag} could not be shared.`);
        }

        if (!strict) {
          v.action = 'skip';
          continue;
        }

        // `accepts` aggregates over the whole version because one version is one file served from one
        // basis — but only the copies that themselves reject the winner have to keep their own build.
        const objecting = new Set(
          v.remotes.filter(
            r => r.strictVersion && !acceptsTag(winner.tag, v.tag, r.requiredVersion)
          )
        );

        if (objecting.size === v.remotes.length) {
          v.action = 'scope';
          continue;
        }

        v.remotes = v.remotes.filter(r => !objecting.has(r));
        v.action = 'skip';
        // Beside its source rather than appended: the record stays newest-first, which `commit()`
        // guarantees and a later election reads as "the latest".
        rebuilt.push({ tag: v.tag, host: false, action: 'scope', remotes: [...objecting] });
      }

      // One row per (tag, action), which the record keeps: a warm record can already hold a `scope` row at
      // the tag a split produces. Merged after the loop, not during it: a row's verdict is not final until
      // the winner has been applied to it. The winner absorbs its tag's other rows, or the `share` below
      // would land on a row merged away.
      external.versions = mergeRows(rebuilt, winner);
    }

    winner.action = 'share';

    applyEntrypointCoveragePolicy(externalName, external);

    external.dirty = false;
    return external;
  };

  // Both settings only govern tears *between* versions: copies of the shared tag always merge.
  // `strictEntryPointCoverage` refuses a tear, `profile.scopeUncoveredEntrypoints` scopes the
  // torn copy, otherwise the import-map builders self-fill it.
  function applyEntrypointCoveragePolicy(externalName: string, external: SharedExternal): void {
    const { strictEntryPointCoverage } = config.strict;
    if (!strictEntryPointCoverage && !config.profile.scopeUncoveredEntrypoints) return;

    const tears = findTears(external);
    if (tears.length === 0) return;

    if (strictEntryPointCoverage) {
      const { version, remote, uncovered } = tears[0]!;
      config.log.error(
        3,
        `[${externalName}@${version.tag}][${remote.name}] Entrypoints not covered by the shared version: ${uncovered.join(', ')}.`
      );
      throw new NFError(
        `External ${externalName} could not be shared without tearing entrypoints.`
      );
    }

    scopeTornRemotes(externalName, external, tears);
  }

  function findTears(external: SharedExternal): Tear[] {
    const shared = external.versions.find(v => v.action === 'share');
    if (!shared) return [];

    const basis = versionEntries(shared);
    const tears: Tear[] = [];

    for (const version of external.versions) {
      if (version.action === 'scope') continue;
      // Its own copies are part of the basis, so they can never tear it.
      if (version === shared) continue;

      version.remotes.forEach(remote => {
        const uncovered = uncoveredEntrypoints(remote, basis);
        if (uncovered.length > 0) tears.push({ version, remote, uncovered });
      });
    }

    return tears;
  }

  function scopeTornRemotes(externalName: string, external: SharedExternal, tears: Tear[]): void {
    const torn = new Set(tears.map(t => t.remote));
    const demotedBySource = new Map<SharedVersion, SharedVersionMeta[]>();

    for (const { version, remote, uncovered } of tears) {
      const group = demotedBySource.get(version);
      if (group) group.push(remote);
      else demotedBySource.set(version, [remote]);

      config.log.debug(
        3,
        `[${externalName}@${version.tag}][${remote.name}] Scoped: entrypoints not covered by the shared version: ${uncovered.join(', ')}.`
      );
    }

    for (const version of external.versions) {
      if (version.remotes.some(r => torn.has(r))) {
        version.remotes = version.remotes.filter(r => !torn.has(r));
      }
    }

    // Inserted before the emptied rows go, so a scope row can take its source's place, as the split's does.
    for (const [source, remotes] of demotedBySource) {
      const { tag } = source;
      const scoped = rowAt(external.versions, tag, 'scope');
      if (scoped) scoped.remotes.push(...remotes);
      else {
        const at = external.versions.indexOf(source) + 1;
        external.versions.splice(at, 0, { tag, host: false, action: 'scope', remotes });
      }
    }
    external.versions = external.versions.filter(v => v.remotes.length > 0);
  }
}

type Tear = { version: SharedVersion; remote: SharedVersionMeta; uncovered: string[] };
