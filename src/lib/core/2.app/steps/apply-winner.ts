import type { SharedExternal, SharedVersion, SharedVersionMeta } from 'lib/core/1.domain';
import { uncoveredEntrypoints, versionEntries } from 'lib/core/1.domain/externals/basis';
import {
  type AcceptsTag,
  type VersionAcceptance,
  versionAcceptance,
} from 'lib/core/1.domain/externals/compatibility';
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
      const { accepts, objector } = acceptance ?? versionAcceptance(external, acceptsTag);

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

      // One row per (tag, action). A warm record can already hold a `scope` row at the tag a split
      // produces — a joiner lands in the deduping row of a split tag and re-splits out of it — and both
      // `findVersionForTag` and `rebuildMember` read a tag as at most one row per action. Merged after the
      // loop, not during it: a row's verdict is not final until the winner has been applied to it.
      const merged = new Map<string, SharedVersion>();
      external.versions = rebuilt.filter(v => {
        const first = merged.get(`${v.tag}|${v.action}`);
        if (!first) {
          merged.set(`${v.tag}|${v.action}`, v);
          return true;
        }
        first.remotes.push(...v.remotes);
        return false;
      });
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
        // Pooling placed this copy in a subpool: the map names that build's files for it, so the shared
        // version is not what it resolves through and cannot tear it.
        if (remote.servedBy) return;

        const uncovered = uncoveredEntrypoints(remote, basis);
        if (uncovered.length > 0) tears.push({ version, remote, uncovered });
      });
    }

    return tears;
  }

  function scopeTornRemotes(externalName: string, external: SharedExternal, tears: Tear[]): void {
    const torn = new Set(tears.map(t => t.remote));
    const demotedByTag = new Map<string, SharedVersionMeta[]>();

    for (const { version, remote, uncovered } of tears) {
      const group = demotedByTag.get(version.tag);
      if (group) group.push(remote);
      else demotedByTag.set(version.tag, [remote]);

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
    external.versions = external.versions.filter(v => v.remotes.length > 0);

    for (const [tag, remotes] of demotedByTag) {
      const scoped = external.versions.find(v => v.tag === tag && v.action === 'scope');
      if (scoped) scoped.remotes.push(...remotes);
      else external.versions.push({ tag, host: false, action: 'scope', remotes });
    }
  }
}

type Tear = { version: SharedVersion; remote: SharedVersionMeta; uncovered: string[] };
