import type { ForPoolingSharedExternals } from '../../driver-ports/init/for-pooling-shared-externals.port';
import type {
  ExternalName,
  RemoteName,
  SharedExternal,
  SharedVersion,
  VersionName,
} from 'lib/core/1.domain';
import { NFError } from 'lib/core/native-federation.error';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { ModeConfig } from '../../config/mode.contract';
import { findVersionForTag } from 'lib/core/1.domain/externals/basis';
import { createApplyWinner, createIsCompatibleMemo, type IsCompatible } from '../apply-winner';
import { buildPools } from './pool-graph';
import { remotesInPool } from './pool.util';
import { buildAcceptanceTable, buildInstances, consumedMembers } from './family-instance';
import { coveredBySingleInstance, currentSharedTags, electInstances } from './elect-instance';
import type { ChosenTags, PoolMember, PoolName } from './pool.types';

type IslandCause = { member: ExternalName; tag: VersionName };

// Remotes that are strict-incompatible on any member (determine marked a version `scope`). Reads
// stored actions only — pooling makes no compatibility call — and islands across the WHOLE family.
// Keeps the first offending member+tag per remote, to name it in the warning.
function islandedRemotes(members: PoolMember[]): Map<RemoteName, IslandCause> {
  const islanded = new Map<RemoteName, IslandCause>();
  for (const member of members)
    for (const version of member.external.versions)
      if (version.action === 'scope')
        for (const remote of version.remotes)
          if (!islanded.has(remote.name))
            islanded.set(remote.name, { member: member.name, tag: version.tag });
  return islanded;
}

export function createPoolSharedExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo' | 'versionCheck'>,
  isCompatible: IsCompatible = createIsCompatibleMemo(ports.versionCheck)
): ForPoolingSharedExternals {
  // A re-election that leaves a strict pin behind is not a hard error: the pin's own remote is
  // islanded and self-serves. Only the pool-level gate below decides whether that throws (§11.5).
  const applyPooledWinner = createApplyWinner({
    ...config,
    strict: { ...config.strict, strictExternalCompatibility: false },
  });

  /**
   * Runs after determine-shared-externals: for each pool, elects the family instance the members are
   * served from (§15.1 rule 3) and islands the remotes that cannot follow it — a remote that is
   * version-incompatible on any member scopes its whole family, so a foreign build cannot leak in
   * through a shared sibling. Emits nothing, only mutates `SharedExternal.versions`.
   * See docs/version-resolver.md.
   *
   * Inert unless `useAutoExternalPooling` is on or an external carries a remote `pool` tag. The
   * `strict` scope is never pooled.
   */
  return () => {
    const { useAutoExternalPooling } = config.feature;

    // With auto-pooling off and no `pool` tag ever seen, nothing can be pooled — skip the scope
    // walk. Auto-pooling on must never early-out: any scoped package is potentially poolable.
    if (!useAutoExternalPooling && !ports.sharedExternalsRepo.hasPoolTag()) {
      return Promise.resolve();
    }

    for (const scope of ports.sharedExternalsRepo.getScopes()) {
      if (ports.sharedExternalsRepo.scopeType(scope) === 'strict') continue;

      const sharedExternals = ports.sharedExternalsRepo.getFromScope(scope);

      try {
        for (const [poolName, members] of buildPools(
          sharedExternals,
          useAutoExternalPooling,
          config.log
        )) {
          poolFamily(poolName, members, scope);
        }
      } catch (error) {
        if (error instanceof NFError) return Promise.reject(error);
        config.log.error(3, `[${scope}] failed to pool shared externals.`, {
          sharedExternals,
          error,
        });
        return Promise.reject(
          new NFError(`Could not pool shared externals in scope ${scope}.`, error as Error)
        );
      }
    }
    return Promise.resolve();
  };

  function poolFamily(poolName: PoolName, members: PoolMember[], scope: string): void {
    // Below 2 members across 2 remotes there is nothing to coordinate; the per-external result is
    // already coherent.
    if (members.length < 2) return;

    const allRemotes = remotesInPool(members);
    if (allRemotes.length < 2) return;

    let islanded = islandedRemotes(members);

    config.log.debug(
      3,
      `[${scope}][pool:${poolName}] ${members.length} members across ${allRemotes.length} remotes, islanded={${[...islanded.keys()].join(', ') || '∅'}}\n` +
        members.map(m => `  - ${m.name}`).join('\n')
    );

    const elected = elect(poolName, members, islanded, scope);

    // Election can make a strict pin reject the new winner, which determine then marks `scope` — so
    // the island gate has to see the post-election verdicts. This is what fixes Case 1.
    if (elected) islanded = islandedRemotes(members);

    // Nothing elected and nobody islanded: determine's verdicts already stand for every member, so
    // rebuilding them would write back what storage holds.
    if (!elected && islanded.size === 0) return;

    // Defensive: determine already throws on real incompatibilities under strictExternalCompatibility.
    if (islanded.size > 0 && config.strict.strictExternalCompatibility) {
      config.log.error(
        3,
        `[${scope}][pool:${poolName}] version-incompatible remotes cannot be pooled: {${[...islanded.keys()].join(', ')}}.`
      );
      throw new NFError(`Could not pool '${poolName}' in scope ${scope}.`);
    }

    for (const [remote, cause] of islanded) {
      config.log.warn(
        3,
        `[${scope}][pool:${poolName}] '${remote}' is islanded: '${cause.member}@${cause.tag}' is incompatible with the shared version, so all ${members.length} members of the pool are scoped for it.`
      );
    }

    for (const member of members) {
      const rebuilt = rebuildMember(member, islanded);
      warnIfScopedOnly(poolName, member, rebuilt, islanded, scope);
      ports.sharedExternalsRepo.addOrUpdate(member.name, rebuilt, scope);
    }
  }

  // Serves every member from the elected family instances (§15.1 rule 3). Returns true when a
  // winner actually moved, which is also what tells `poolFamily` that storage must be rewritten.
  function elect(
    poolName: PoolName,
    members: PoolMember[],
    islanded: Map<RemoteName, IslandCause>,
    scope: string
  ): boolean {
    const instances = buildInstances(members, islanded);
    if (instances.size < 2) return false;

    const current = currentSharedTags(members);
    if (coveredBySingleInstance(instances, current)) return false;

    const consumed = consumedMembers(members);
    const acceptance = buildAcceptanceTable(instances, members, isCompatible);
    const chosen = electInstances(members, instances, acceptance, consumed);

    let moved = false;
    for (const member of members) {
      const tag = chosen.get(member.name);
      if (tag === undefined || current.get(member.name) === tag) continue;
      if (repoint(member, tag, islanded)) moved = true;
    }

    if (moved) {
      config.log.debug(
        3,
        `[${scope}][pool:${poolName}] elected ${describeTags(chosen)} (was ${describeTags(current)}).`
      );
    }
    return moved;
  }

  function describeTags(tags: ChosenTags): string {
    return (
      [...tags]
        .map(([member, tag]) => `${member}@${tag}`)
        .sort()
        .join(', ') || '∅'
    );
  }

  // Moves a member's winner onto the elected tag and re-derives every verdict through the shared
  // election tail, so entrypoint coverage and tear handling stay in one place (research.md §8).
  function repoint(
    member: PoolMember,
    tag: VersionName,
    islanded: Map<RemoteName, IslandCause>
  ): boolean {
    const version = findVersionForTag(member.external.versions, tag);
    if (!version || version.action === 'scope') return false;

    // The basis serves the version, so it must be a copy that survives islanding — coverage and tear
    // analysis key off `remotes[0].entries`.
    const alive = version.remotes.findIndex(r => !islanded.has(r.name));
    if (alive > 0) version.remotes.unshift(...version.remotes.splice(alive, 1));

    splitObjectors(member, version, tag);
    applyPooledWinner(member.name, member.external, version, isCompatible);
    return true;
  }

  /**
   * A verdict is per version, but §15's acceptance test is per remote — and a version's remotes can
   * disagree, since `requiredVersion`/`strictVersion` are per build. Left alone, one strict co-tenant
   * would scope the whole version and island every remote that happens to ship the same tag: measured
   * on `benchmark/` (captured 7 + `eleven`) that is 5 remotes islanded instead of 1, and 70 downloads
   * instead of 36. So the objectors are split off into their own same-tag version first, which is a
   * shape the resolver already produces (see `findVersionForTag`, `scopeTornRemotes`).
   */
  function splitObjectors(member: PoolMember, winner: SharedVersion, tag: VersionName): void {
    const split: SharedVersion[] = [];

    for (const version of member.external.versions) {
      if (version === winner || version.action === 'scope' || version.remotes.length < 2) continue;

      const objectors = version.remotes.filter(
        r => r.strictVersion && !isCompatible(tag, r.requiredVersion)
      );
      if (objectors.length === 0 || objectors.length === version.remotes.length) continue;

      version.remotes = version.remotes.filter(r => !objectors.includes(r));
      split.push({ tag: version.tag, host: false, action: 'scope', remotes: objectors });
    }

    member.external.versions.push(...split);
  }

  // Warn only when sharing was genuinely possible and lost: a scoped-only member with >1 consumer. A
  // single-consumer member is one download either way, so pooling could not have improved it.
  function warnIfScopedOnly(
    poolName: PoolName,
    member: PoolMember,
    rebuilt: SharedExternal,
    islanded: Map<RemoteName, IslandCause>,
    scope: string
  ): void {
    if (rebuilt.versions.some(v => v.action === 'share')) return;
    const consumers = new Set(rebuilt.versions.flatMap(v => v.remotes.map(r => r.name))).size;
    if (consumers < 2) return;

    // An island took this member's last provider: its own warning already named the cause, and this
    // one would only restate the effect.
    const provider = member.external.versions.find(v => v.action === 'share');
    if (provider?.remotes.some(r => islanded.has(r.name))) return;

    config.log.warn(
      3,
      `[${scope}][pool:${poolName}] '${member.name}' is scoped-only — no coherent shared build provides it; ${consumers} remotes download their own copy.`
    );
  }

  // Island-or-defer at remote-copy granularity: islanded (or already-`scope`) copies self-serve;
  // every other copy keeps its base verdict. Scope versions group by each copy's real tag (F3).
  function rebuildMember(
    member: PoolMember,
    islanded: Map<RemoteName, IslandCause>
  ): SharedExternal {
    const entries = member.external.versions.flatMap(v =>
      v.remotes.map(meta => ({
        remote: meta.name,
        tag: v.tag,
        host: v.host,
        action: v.action,
        meta,
      }))
    );

    const isScoped = (e: (typeof entries)[number]) =>
      islanded.has(e.remote) || e.action === 'scope';

    let scoped = entries.filter(isScoped);
    let clean = entries.filter(e => !isScoped(e));

    // Winner islanded away: no shared build survives, so the orphaned `skip` copies self-serve too.
    if (!clean.some(e => e.action === 'share')) {
      scoped = [...scoped, ...clean];
      clean = [];
    }

    const shareEntries = clean.filter(e => e.action === 'share');
    const shareVersion: SharedVersion[] =
      shareEntries.length > 0
        ? [
            {
              tag: shareEntries[0]!.tag,
              host: shareEntries[0]!.host,
              action: 'share',
              remotes: shareEntries.map(e => e.meta),
            },
          ]
        : [];

    const skipByTag = new Map<string, SharedVersion>();
    for (const e of clean) {
      if (e.action !== 'skip') continue;
      const version = skipByTag.get(e.tag) ?? {
        tag: e.tag,
        host: e.host,
        action: 'skip' as const,
        remotes: [],
      };
      version.remotes.push(e.meta);
      skipByTag.set(e.tag, version);
    }

    const scopeByTag = new Map<string, SharedVersion>();
    for (const e of scoped) {
      const version = scopeByTag.get(e.tag) ?? {
        tag: e.tag,
        host: false,
        action: 'scope' as const,
        remotes: [],
      };
      version.remotes.push(e.meta);
      scopeByTag.set(e.tag, version);
    }

    return {
      dirty: false,
      versions: [...shareVersion, ...skipByTag.values(), ...scopeByTag.values()],
    };
  }
}
