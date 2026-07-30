import type { SharedExternal, SharedVersion, SharedVersionMeta } from 'lib/core/1.domain';
import { uncoveredEntrypoints, versionDemands } from 'lib/core/1.domain/externals/basis';
import { NFError } from 'lib/core/native-federation.error';
import type { ForVersionChecking } from '../driving-ports/for-version-checking.port';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';

export type IsCompatible = (tag: string, requiredVersion: string) => boolean;

/**
 * The resolver's selection loop asks O(versions² × demands) questions but has only
 * (candidate tag × distinct requiredVersion) distinct ones, and pooling then asks the same set again.
 * One memo therefore serves both steps; `isCompatible` is pure, so entries never go stale.
 */
export function createIsCompatibleMemo(
  versionCheck: Pick<ForVersionChecking, 'isCompatible'>
): IsCompatible {
  const memo = new Map<string, boolean>();
  return (tag, requiredVersion) => {
    const key = `${tag}|${requiredVersion}`;
    let hit = memo.get(key);
    if (hit === undefined) {
      hit = versionCheck.isCompatible(tag, requiredVersion);
      memo.set(key, hit);
    }
    return hit;
  };
}

export type VersionAcceptance = {
  // A version can only be redirected to `tag` if none of its remotes rejects that tag.
  accepts: (version: SharedVersion, tag: string) => boolean;
  // The remote that makes the redirect unsafe: it rejects `tag` and pinned `strictVersion`,
  // so it has to keep its own build instead of being deduped away.
  objector: (version: SharedVersion, tag: string) => SharedVersionMeta | undefined;
  // For callers asking a question of their own, e.g. the resolver's extra-download count.
  demands: (version: SharedVersion) => SharedVersionMeta[];
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
    demands: version => demands.get(version)!,
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

      external.versions.forEach(v => {
        if (accepts(v, winner.tag)) {
          v.action = 'skip';
          return;
        }

        const strict = objector(v, winner.tag);

        if (config.strict.strictExternalCompatibility && strict) {
          config.log.error(
            3,
            `[${strict.name}][${externalName}@${v.tag}] Is not compatible with requiredRange '${strict.requiredVersion}' of shared ${externalName}@${winner.tag}.`
          );

          throw new NFError(`External ${externalName}@${v.tag} could not be shared.`);
        }
        v.action = strict ? 'scope' : 'skip';
      });
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
