import type { ForPoolingSharedExternals } from '../../driver-ports/init/for-pooling-shared-externals.port';
import type { TouchedExternals } from '../../driver-ports/init/for-determining-shared-externals.port';
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
import {
  buildInstances,
  consumedMembers,
  ownTagsPerRemote,
  servingBuilds,
} from './family-instance';
import {
  acceptanceTable,
  arrivalOrder,
  assignAnchors,
  basisPerMember,
  consumedSpecifiers,
  coveragePerBuild,
  explainSelfServe,
  hostRemotes,
  isWitnessed,
  sharedTagPerSpecifier,
  tagsPerBuild,
} from './anchoring';
import { buildPools } from './pool-graph';
import { remotesInPool } from './pool.util';
import type { PoolMember, PoolName } from './pool.types';

type IslandCause =
  // determine marked one of its versions `scope`: a genuine range violation.
  | { kind: 'incompatible'; member: ExternalName; tag: VersionName }
  // No build in the pool serves everything it consumes at versions it accepts, and no build witnesses
  // the combination the global mapping offers it either. `gap` is what the closest build fell short on.
  | { kind: 'uncovered'; gap: string; closest?: RemoteName }
  // The record about to be written would hand it members from builds that never shipped them together.
  // The gates leave this unreachable; it is checked anyway because it is the one thing pooling exists to
  // prevent — see `findTornRemotes`.
  | { kind: 'torn'; combination: string };

/**
 * Per remote, the members it must be served from a build other than that member's own basis — an
 * anchor's, or its own where it is an anchor for somebody else. Absent means the default: the copy
 * resolves through the global mapping, which is right whenever the shared tag is already the remote's
 * own. See docs/version-resolver.md §"The provenance promise".
 */
type Served = Map<RemoteName, Map<ExternalName, RemoteName>>;

/** The build serving each remote the gate moved, itself where it serves its own family. */
type ServingBuild = Map<RemoteName, RemoteName>;

// Remotes that are strict-incompatible on any member (determine marked a version `scope`). Reads
// stored actions only — pooling makes no compatibility call — and islands across the WHOLE family.
// Keeps the first offending member+tag per remote, to name it in the warning.
//
// Sound because `spread-pool-dirtiness` re-elects a pool as a unit: this step runs on a pool exactly
// when every member of it was re-elected, so a `scope` here is always determine's and always describes
// the current portfolio, never a verdict `rebuildMember` wrote for an earlier one.
function islandedRemotes(members: PoolMember[]): Map<RemoteName, IslandCause> {
  const islanded = new Map<RemoteName, IslandCause>();
  for (const member of members)
    for (const version of member.external.versions)
      if (version.action === 'scope')
        for (const remote of version.remotes)
          if (!islanded.has(remote.name))
            islanded.set(remote.name, {
              kind: 'incompatible',
              member: member.name,
              tag: version.tag,
            });
  return islanded;
}

const basisFor = (
  members: PoolMember[],
  islanded: Map<RemoteName, IslandCause>,
  serving: ServingBuild
): Map<ExternalName, RemoteName> =>
  basisPerMember(members, islanded, remote => {
    const build = serving.get(remote);
    return build !== undefined && build !== remote;
  });

// Only where the serving build differs from what the global mapping already publishes: a remote whose
// anchor *is* the basis resolves through `imports` and needs no scope entry at all (Performance §9).
function servedPerRemote(
  consumed: Map<RemoteName, ExternalName[]>,
  serving: ServingBuild,
  basis: Map<ExternalName, RemoteName>
): Served {
  const served: Served = new Map();

  for (const [remote, build] of serving) {
    const byMember = new Map<ExternalName, RemoteName>();
    for (const name of consumed.get(remote) ?? []) {
      if (basis.get(name) !== build) byMember.set(name, build);
    }
    if (byMember.size > 0) served.set(remote, byMember);
  }

  return served;
}

/**
 * The no-tear guarantee, checked on what is about to be written rather than argued from the gates: every
 * non-host remote must resolve a `(member → tag)` combination that some single build shipped. Which remote
 * serves a tag is free — two builds at one tag are interchangeable providers — so this compares tags only,
 * never origins.
 *
 * The gates already leave it true: an islanded remote self-serves its whole family, an anchored one takes
 * every member from a build the coverage rule vetted, and an unassigned one was witnessed. The reason to
 * check regardless is `rebuildMember`'s last rule — when a member loses its basis, a copy with no
 * `servedBy` self-serves — which is decided after gate 2 has stopped looking.
 *
 * A host is never judged: it cannot be repointed onto another build, so there is nothing to enforce.
 *
 * Exported for its own test: no portfolio reaches it through `poolFamily`, so the contract has to be
 * pinned on hand-built input.
 */
export function findTornRemotes(
  members: PoolMember[],
  islanded: Map<RemoteName, IslandCause>,
  consumed: Map<RemoteName, ExternalName[]>,
  basis: Map<ExternalName, RemoteName>,
  served: Served,
  hosts: ReadonlySet<RemoteName>
): { remote: RemoteName; combination: string }[] {
  const { suspect, selfServed } = movedRemotes(members, islanded, basis, served, hosts);
  if (suspect.size === 0) return [];

  const instances = buildInstances(members, islanded);
  const own = ownTagsPerRemote(members, suspect);
  const torn: { remote: RemoteName; combination: string }[] = [];

  for (const remote of suspect) {
    const ownBuild = own.get(remote);
    const mine = selfServed.get(remote);
    const resolved = new Map<ExternalName, VersionName>();

    for (const member of consumed.get(remote) ?? []) {
      // A copy `rebuildMember` will scope resolves itself whatever the member's basis is; otherwise an
      // explicit anchor, else the global mapping, else nobody publishes it and it self-serves anyway.
      const from = mine?.has(member)
        ? remote
        : (served.get(remote)?.get(member) ?? basis.get(member) ?? remote);
      // Its own tags are read from every row, `scope` included: a copy about to self-serve is what a tear
      // is made of, and `buildInstances` leaves those out by design.
      const tag = from === remote ? ownBuild?.get(member) : instances.get(from)?.get(member);
      if (tag !== undefined) resolved.set(member, tag);
    }
    if (resolved.size === 0) continue;

    // Its own build first: a remote running its whole family from itself is coherent by definition, and
    // that is where a self-serving copy has just put it.
    if (ships(ownBuild, resolved)) continue;

    let witnessed = false;
    for (const [, build] of instances) {
      if (ships(build, resolved)) {
        witnessed = true;
        break;
      }
    }

    if (!witnessed) {
      torn.push({
        remote,
        combination: [...resolved].map(([member, tag]) => `${member}@${tag}`).join(', '),
      });
    }
  }

  return torn;
}

const ships = (
  build: Map<ExternalName, VersionName> | undefined,
  resolved: Map<ExternalName, VersionName>
): boolean => {
  if (!build) return false;
  for (const [member, tag] of resolved) if (build.get(member) !== tag) return false;
  return true;
};

/**
 * The only remotes whose resolution pooling can have changed, and therefore the only ones worth checking:
 * one it anchored elsewhere, one consuming a member nothing publishes any more (`rebuildMember` self-serves
 * such a copy), or one holding a `scope` copy without being islanded — which gate 1 makes impossible and is
 * listed anyway, since it is the shape a tear would take if that ever stopped holding. Everything else
 * resolves the global mapping wholesale, exactly as gate 2 witnessed it.
 *
 * `selfServed` is what each of them must serve itself, mirroring `rebuildMember` so the two cannot drift.
 */
function movedRemotes(
  members: PoolMember[],
  islanded: Map<RemoteName, IslandCause>,
  basis: Map<ExternalName, RemoteName>,
  served: Served,
  hosts: ReadonlySet<RemoteName>
): { suspect: Set<RemoteName>; selfServed: Map<RemoteName, Set<ExternalName>> } {
  const suspect = new Set<RemoteName>();
  const selfServed = new Map<RemoteName, Set<ExternalName>>();

  const add = (remote: RemoteName) => {
    if (!islanded.has(remote) && !hosts.has(remote)) suspect.add(remote);
  };

  for (const remote of served.keys()) add(remote);

  for (const member of members) {
    const unpublished = !basis.has(member.name);
    for (const version of member.external.versions) {
      const scoped = version.action === 'scope';
      if (!unpublished && !scoped) continue;

      for (const meta of version.remotes) {
        add(meta.name);
        // A scoped copy always serves itself, and a clean copy of a member nothing publishes any more does
        // too — unless pooling gave it an anchor, which is the one thing that keeps such a copy deduping.
        const servesItself =
          scoped || (unpublished && served.get(meta.name)?.get(member.name) === undefined);
        if (!servesItself) continue;

        let mine = selfServed.get(meta.name);
        if (!mine) selfServed.set(meta.name, (mine = new Set()));
        mine.add(member.name);
      }
    }
  }

  return { suspect, selfServed };
}

export function createPoolSharedExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo' | 'versionCheck'>
): ForPoolingSharedExternals {
  /**
   * Runs after determine-shared-externals: for each pool, a remote that is version-incompatible on any
   * member is islanded (its whole family scopes, no dedup) so a foreign build cannot leak in through a
   * shared sibling; every other remote keeps the base per-external verdict. Emits nothing, only
   * mutates `SharedExternal.versions`. See docs/version-resolver.md.
   *
   * Inert unless `useAutoExternalPooling` is on or an external carries a remote `pool` tag. The
   * `strict` scope is never pooled.
   *
   * `touched` (determine's re-elected externals per scope) gates the work: a pool no member of which
   * was re-elected resolves to what storage already holds. Because `spread-pool-dirtiness` runs first,
   * a touched pool is a *wholly* re-elected pool — which is what makes gate 1 sound. A warm init
   * therefore does no per-member work at all.
   */
  return (touched?: TouchedExternals) => {
    const { useAutoExternalPooling } = config.feature;

    // With auto-pooling off and no `pool` tag ever seen, nothing can be pooled — skip the scope
    // walk. Auto-pooling on must never early-out: any scoped package is potentially poolable.
    if (!useAutoExternalPooling && !ports.sharedExternalsRepo.hasPoolTag()) {
      return Promise.resolve();
    }

    for (const scope of ports.sharedExternalsRepo.getScopes()) {
      if (ports.sharedExternalsRepo.scopeType(scope) === 'strict') continue;

      const touchedInScope = touched?.get(scope);
      if (touched && !touchedInScope) continue;

      const sharedExternals = ports.sharedExternalsRepo.getFromScope(scope);

      try {
        for (const [poolName, members] of buildPools(
          sharedExternals,
          useAutoExternalPooling,
          config.log
        )) {
          if (touchedInScope && !members.some(m => touchedInScope.has(m.name))) continue;
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

    const islanded = islandedRemotes(members);

    config.log.debug(
      3,
      `[${scope}][pool:${poolName}] ${members.length} members across ${allRemotes.length} remotes, incompatible={${[...islanded.keys()].join(', ') || '∅'}}\n` +
        members.map(m => `  - ${m.name}`).join('\n')
    );

    let serving = assignServingBuilds(members, islanded);

    // Nothing to island and nothing reassigned: determine's verdicts already stand for every member, so
    // rebuilding them would write back what storage holds.
    if (islanded.size === 0 && serving.size === 0) return;

    const consumed = consumedMembers(members);
    const hosts = hostRemotes(members);
    let basis = basisFor(members, islanded, serving);
    let served = servedPerRemote(consumed, serving, basis);

    // Enforce the no-tear guarantee instead of relying on the gates to imply it. Self-serving a whole
    // family is always coherent, so a torn remote is islanded and the assignment redone — taking a build
    // away can move everyone who was deduping onto it. Monotone, exactly as the coverage gate is: each
    // round islands at least one more remote, so it terminates.
    for (;;) {
      const torn = findTornRemotes(members, islanded, consumed, basis, served, hosts);
      if (torn.length === 0) break;

      for (const { remote, combination } of torn)
        islanded.set(remote, { kind: 'torn', combination });
      serving = assignServingBuilds(members, islanded);
      basis = basisFor(members, islanded, serving);
      served = servedPerRemote(consumed, serving, basis);
    }

    // Defensive: determine already throws on real incompatibilities under strictExternalCompatibility. A
    // remote serving its own family for lack of coverage is not one of them (constraint 10) — nothing about
    // its versions is wrong, so it must not turn a strict portfolio into a failure.
    const incompatible = [...islanded]
      .filter(([, cause]) => cause.kind === 'incompatible')
      .map(([remote]) => remote);
    if (config.strict.strictExternalCompatibility && incompatible.length > 0) {
      config.log.error(
        3,
        `[${scope}][pool:${poolName}] version-incompatible remotes cannot be pooled: {${incompatible.join(', ')}}.`
      );
      throw new NFError(`Could not pool '${poolName}' in scope ${scope}.`);
    }

    // Two different things, deliberately worded apart: an incompatibility is a version the portfolio
    // cannot honour, a coverage self-serve is a family nothing shipped together. The second is the
    // promise's main cost and used to be invisible, because coverage moves a remote without a verdict.
    for (const [remote, cause] of islanded) {
      // What scopes is what this remote has a copy of, which in a ragged pool is fewer than the pool.
      const scoped = consumed.get(remote)?.length ?? 0;
      if (cause.kind === 'incompatible') {
        config.log.warn(
          3,
          `[${scope}][pool:${poolName}] '${remote}' is islanded: the resolver scoped its '${cause.member}@${cause.tag}', so all ${scoped} members it imports are scoped for it.`
        );
        continue;
      }
      if (cause.kind === 'torn') {
        config.log.warn(
          3,
          `[${scope}][pool:${poolName}] '${remote}' serves its own family: the mapping would have handed it ${cause.combination}, which no build shipped together, so all ${scoped} members it imports are scoped for it.`
        );
        continue;
      }
      const closest = cause.closest
        ? `closest is '${cause.closest}'`
        : 'no other build in the pool serves any of it';
      config.log.warn(
        3,
        `[${scope}][pool:${poolName}] '${remote}' serves its own family: no shared build offers every entrypoint it imports at a version it accepts — '${cause.gap}' is the gap, ${closest}. All ${scoped} members it imports are scoped for it.`
      );
    }

    for (const member of members) {
      const rebuilt = rebuildMember(member, islanded, served, basis.get(member.name));
      warnIfScopedOnly(poolName, member, rebuilt, islanded, scope);
      ports.sharedExternalsRepo.addOrUpdate(member.name, rebuilt, scope);
    }
  }

  /**
   * The coverage gate. A remote may dedup onto a build only when that build serves a **superset** of
   * what it consumes, at versions its own `requiredVersion` accepts — no tag distance is read anywhere,
   * so a family split no build witnesses can no longer pass as benign patch drift. A remote that no
   * build covers falls back to the same-tag witness: every member already published at exactly its own
   * tag is one its own build compiled beside the rest of the family, so its own build is the witness.
   * Failing both, it serves its whole family itself.
   *
   * Monotone, exactly as islanding was: scoping a remote removes it as a serving build, which can leave
   * a member unserved and push another remote onto its own build. So the gate repeats, and only after a
   * round that scoped someone.
   */
  function assignServingBuilds(
    members: PoolMember[],
    islanded: Map<RemoteName, IslandCause>
  ): ServingBuild {
    for (;;) {
      const bases = servingBuilds(members, islanded);

      // One build serves every member, so it covers everyone by construction and every copy already
      // resolves to it. The healthy-portfolio path: no coverage sets, no acceptance table, no
      // assignment, nothing written (Performance §2).
      if (new Set(bases.values()).size < 2 && bases.size === members.length) return new Map();

      const shared = sharedTagPerSpecifier(members, islanded);
      const ownTags = tagsPerBuild(members, islanded);
      const consumedSpec = consumedSpecifiers(members);
      const consumed = consumedMembers(members);

      const needAnchor = new Map<RemoteName, ExternalName[]>();
      const needSpecifiers = new Map<RemoteName, Set<string>>();
      for (const [remote, wants] of consumed) {
        if (islanded.has(remote)) continue;
        if (isWitnessed(consumedSpec.get(remote) ?? [], shared, ownTags)) continue;
        needAnchor.set(remote, wants);
        needSpecifiers.set(remote, consumedSpec.get(remote) ?? new Set());
      }

      if (needAnchor.size === 0) return new Map();

      const coverage = coveragePerBuild(members, islanded);
      const hosts = hostRemotes(members);
      const instances = buildInstances(members, islanded);
      const acceptance = acceptanceTable(members, ports.versionCheck.isCompatible);
      const assignment = assignAnchors({
        instances,
        coverage,
        acceptance,
        consumedSpecifiers: needSpecifiers,
        consumedMembers: needAnchor,
        hosts,
        arrival: arrivalOrder(members),
      });

      // A build somebody else dedups onto has to run its own copies of what it hands out, or the files
      // it serves would bind their peers against a different build one hop in (constraint 4).
      const anchors = new Set<RemoteName>();
      for (const build of assignment.values()) if (build !== undefined) anchors.add(build);

      const serving: ServingBuild = new Map();
      let scoped = false;

      for (const [remote, wants] of needAnchor) {
        const assigned = assignment.get(remote);
        const build = assigned ?? (anchors.has(remote) || hosts.has(remote) ? remote : undefined);

        if (build === undefined) {
          islanded.set(remote, {
            kind: 'uncovered',
            ...explainSelfServe(remote, wants, needSpecifiers.get(remote)!, {
              coverage,
              instances,
              acceptance,
            }),
          });
          scoped = true;
          continue;
        }

        serving.set(remote, build);
      }

      if (!scoped) return serving;
    }
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
    // Only the scoped copies really download their own file: a copy that lost the global mapping but
    // carries a `servedBy` still dedups, onto its anchor's build, and saying otherwise would be false.
    const consumers = new Set(
      rebuilt.versions.filter(v => v.action === 'scope').flatMap(v => v.remotes.map(r => r.name))
    ).size;
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
  // A surviving copy also records the build serving it whenever that is not the member's own basis, so
  // the map can point it at another origin's files — emission reads it, and only the global path needs it.
  //
  // `basis` is the copy the global mapping publishes; `undefined` means none is left and the member
  // leaves the shared set (constraint 15).
  function rebuildMember(
    member: PoolMember,
    islanded: Map<RemoteName, IslandCause>,
    served: Served,
    basis: RemoteName | undefined
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

    for (const entry of clean) {
      const build = served.get(entry.remote)?.get(member.name);
      if (build !== undefined) entry.meta.servedBy = build;
      else delete entry.meta.servedBy;
    }

    // No basis left: nothing publishes this member, so a copy that was resolving through the global
    // mapping has nowhere to go and self-serves. A copy with a `servedBy` is mapped explicitly and keeps
    // its dedup — sweeping it too is what made N providers of one tag download N copies (constraint 15).
    if (basis === undefined) {
      scoped = [...scoped, ...clean.filter(e => e.meta.servedBy === undefined)];
      clean = clean
        .filter(e => e.meta.servedBy !== undefined)
        .map(e => ({ ...e, action: 'skip' as const }));
    }

    // Basis first: `remotes[0]` is what the global mapping and a later re-election read as the serving
    // copy, and only a copy that runs its own build may be it.
    const shareEntries = clean
      .filter(e => e.action === 'share')
      .sort((a, b) => Number(b.remote === basis) - Number(a.remote === basis));
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
        // Drops any `host` bit, which a later re-election would need. Unreachable: the host wins every
        // external it ships, so it is never gate-1 islanded, and it is the serving basis for all of them,
        // so gate 2 never fires on it either — it is never in `scoped`.
        host: false,
        action: 'scope' as const,
        remotes: [],
      };
      version.remotes.push(e.meta);
      scopeByTag.set(e.tag, version);
    }

    // Descending by tag, the order `commit()` guarantees and `determine` reads as "the latest" — see
    // store-remote-entry.version-order.spec.ts. Grouping by action would break it, and a later init
    // re-elects this record without `commit()` ever passing over it again.
    return {
      dirty: false,
      versions: [...shareVersion, ...skipByTag.values(), ...scopeByTag.values()].sort((a, b) =>
        ports.versionCheck.compare(b.tag, a.tag)
      ),
    };
  }
}
