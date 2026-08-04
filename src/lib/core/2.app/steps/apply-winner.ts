import type { SharedExternal, SharedVersion, SharedVersionMeta } from 'lib/core/1.domain';
import { uncoveredEntrypoints, versionDemands } from 'lib/core/1.domain/externals/basis';
import { NFError } from 'lib/core/native-federation.error';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';

export type IsCompatible = (tag: string, requiredVersion: string) => boolean;

export type VersionAcceptance = {
  // A version can only be redirected to `tag` if none of its remotes rejects that tag.
  accepts: (version: SharedVersion, tag: string) => boolean;
  // A representative copy that makes the redirect unsafe: it rejects `tag` while `strictVersion` is set,
  // so it keeps its own build instead of being deduped away. One is enough for the message and the
  // strict check; `applyWinner` enumerates the rest itself when it splits the version.
  objector: (version: SharedVersion, tag: string) => SharedVersionMeta | undefined;
};

// Every compatibility question is asked of the whole version, not of its basis: see `versionDemands`.
// Computed once per external, since the selection loop is O(versions²).
export function versionAcceptance(
  external: SharedExternal,
  isCompatible: IsCompatible
): VersionAcceptance {
  const demands = new Map<SharedVersion, SharedVersionMeta[]>(
    external.versions.map(v => [v, versionDemands(v)])
  );

  return {
    accepts: (version, tag) =>
      demands.get(version)!.every(d => isCompatible(tag, d.requiredVersion)),
    objector: (version, tag) =>
      demands.get(version)!.find(d => d.strictVersion && !isCompatible(tag, d.requiredVersion)),
  };
}

/**
 * The tail of winner election: derive every other version's verdict from the chosen one, apply the
 * entrypoint coverage policy, clear `dirty`.
 *
 * Shared with pooling, which re-points a winner onto a family instance and so also moves the
 * `remotes[0]` serving basis that `findTears` keys off. Pooling passes in the resolver's memoized
 * `isCompatible` rather than building a second memo.
 */
export function createApplyWinner(config: LoggingConfig & ModeConfig) {
  return function applyWinner(
    externalName: string,
    external: SharedExternal,
    winner: SharedVersion,
    isCompatible: IsCompatible,
    acceptance?: VersionAcceptance
  ): SharedExternal {
    // A lone version has nothing to redirect, so it is never asked a compatibility question — which
    // is also why it is never strict-checked against its own tag.
    if (external.versions.length > 1) {
      const { accepts, objector } = acceptance ?? versionAcceptance(external, isCompatible);

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

        // The winner is never redirected, so its copies are never really asked to accept its own tag;
        // its verdict is `winner.action` below. Splitting it would scope copies that dedup today. Covers
        // the host row too, which host precedence always makes the winner.
        if (v === winner) continue;

        if (!strict) {
          v.action = 'skip';
          continue;
        }

        // `accepts` aggregates over the whole version because one version is one file served from one
        // basis — but only the copies that themselves reject the winner have to keep their own build.
        const objecting = new Set(
          v.remotes.filter(r => r.strictVersion && !isCompatible(winner.tag, r.requiredVersion))
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

      external.versions = rebuilt;
    }

    winner.action = 'share';

    applyEntrypointCoveragePolicy(externalName, external);

    external.dirty = false;
    return external;
  };

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

    const basis = shared.remotes[0]!.entries;
    const tears: Tear[] = [];

    for (const version of external.versions) {
      if (version.action === 'scope') continue;

      version.remotes.forEach((remote, index) => {
        if (version === shared && index === 0) return;

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
