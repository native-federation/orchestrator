import type { ForPoolingSharedExternals } from '../../driver-ports/init/for-pooling-shared-externals.port';
import type { TouchedExternals } from '../../driver-ports/init/for-determining-shared-externals.port';
import type {
  ExternalName,
  RemoteName,
  SharedExternal,
  SharedVersion,
  SharedVersionMeta,
  VersionName,
} from 'lib/core/1.domain';
import { NFError } from 'lib/core/native-federation.error';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { ModeConfig } from '../../config/mode.contract';
import {
  arrivalOrder,
  basisPerMember,
  consumedMembers,
  consumedSpecifiers,
  coversWholePool,
  hostRemotes,
  liveBuilds,
  ownCopies,
  servingBuilds,
  sharedTagPerSpecifier,
} from './pool-views';
import {
  acceptanceTable,
  assignAnchors,
  explainSelfServe,
  isWitnessed,
  type Acceptance,
} from './anchoring';
import { buildPools } from './pool-graph';
import { lazy, poolableScopes, remotesInPool } from './pool.util';
import type { Islanded, PoolMember, PoolName, Specifier } from './pool.types';

type IslandCause =
  // determine marked one of its versions `scope`: a genuine range violation.
  | { kind: 'incompatible'; member: ExternalName; tag: VersionName }
  // No build in the pool serves everything it consumes at versions it accepts, and no build witnesses the
  // combination the global mapping offers it either. `gap` is what the closest build fell short on.
  | { kind: 'uncovered'; gap: string; closest?: RemoteName }
  // The record about to be written would hand it members from builds that never shipped them together.
  // See `findTornRemotes` for why this is checked when no portfolio is known to reach it.
  | { kind: 'torn'; combination: string };

/**
 * Per remote, the members it must be served from a build other than that member's own basis — an anchor's,
 * or its own where it is an anchor for somebody else. Absent means the default: the copy resolves through
 * the global mapping, which is right whenever the shared tag is already the remote's own.
 */
type Served = Map<RemoteName, Map<ExternalName, RemoteName>>;

/** The build serving each remote the gate moved, itself where it serves its own family. */
type ServingBuild = Map<RemoteName, RemoteName>;

/** Projections gate 2 reads that no round of it can change. */
type GateViews = {
  consumedSpecifiers: () => Map<RemoteName, Set<Specifier>>;
  acceptance: () => Acceptance;
  arrival: () => Map<RemoteName, number>;
};

/**
 * Gate 1: remotes that are strict-incompatible on any member, islanded across the WHOLE family. Reads
 * stored actions only — pooling makes no compatibility call.
 *
 * Sound only because `mark-pools-for-reelection` re-elects a pool as a unit, which makes every `scope` seen
 * here determine's own rather than an island `rebuildMember` persisted for an earlier portfolio.
 */
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
  islanded: Islanded,
  serving: ServingBuild
): Map<ExternalName, RemoteName> =>
  basisPerMember(members, islanded, remote => {
    const build = serving.get(remote);
    return build !== undefined && build !== remote;
  });

// Only where the serving build differs from what the global mapping already publishes: a remote whose
// anchor *is* the basis resolves through `imports` and needs no scope entry at all.
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

// Whether the stored record still names an anchor for anybody. A pool that needs no anchor this election is
// only a no-op if the record agrees: a `servedBy` from an earlier portfolio would keep pointing the map at a
// build gate 2 did not choose this time, and `rebuildMember` is what clears it.
const anyAnchorStored = (members: PoolMember[]): boolean =>
  members.some(m => m.external.versions.some(v => v.remotes.some(r => r.servedBy !== undefined)));

/**
 * The no-tear guarantee, checked on what is about to be written rather than argued from the gates: every
 * non-host remote must resolve a `(specifier → tag)` combination that some single build shipped. Which remote
 * serves a tag is free — two builds at one tag are interchangeable providers — so this compares tags only,
 * never origins. A host is never judged: it cannot be repointed onto another build.
 *
 * Keyed by specifier like everything else in the design, not by member: an entrypoint the serving basis lacks
 * is published from a sibling copy at that copy's tag (`selfFillUncovered`), so a member-level check reads one
 * tag for a package the remote really resolves at two.
 *
 * No portfolio is known to reach a tear through `poolFamily` — the gates leave it true — and it is checked
 * regardless, because it is the one thing pooling exists to prevent and because `rebuildMember`'s last rule
 * (a copy whose member lost its basis self-serves) is decided after gate 2 has stopped looking. Exported so
 * `find-torn-remotes.spec.ts` can pin the contract on hand-built input, the only way to reach it.
 */
export function findTornRemotes(
  members: PoolMember[],
  islanded: Islanded,
  basis: Map<ExternalName, RemoteName>,
  served: Served,
  hosts: ReadonlySet<RemoteName>
): { remote: RemoteName; combination: string }[] {
  const { suspect, selfServed } = movedRemotes(members, islanded, basis, served, hosts);
  if (suspect.size === 0) return [];

  const builds = liveBuilds(members, islanded);
  // What the global `imports` publishes per specifier — not the member's basis, which understates it
  // exactly where a tear hides.
  const shared = sharedTagPerSpecifier(members, islanded);
  const own = ownCopies(members, suspect);
  const torn: { remote: RemoteName; combination: string }[] = [];

  for (const remote of suspect) {
    const copies = own.get(remote) ?? [];
    const mine = selfServed.get(remote);
    const anchors = served.get(remote);
    // Its own tags are read from every row, `scope` included: a copy about to self-serve is what a tear is
    // made of, and `liveBuilds` leaves those out by design.
    const ownTags = new Map<Specifier, VersionName>();
    const resolved = new Map<Specifier, VersionName>();

    for (const copy of copies) {
      // A copy `rebuildMember` will scope resolves itself whatever the member's basis is; otherwise an
      // explicit anchor, else the global mapping — and where that publishes nothing, nobody serves the
      // specifier and there is no combination to judge.
      const from = mine?.has(copy.member) ? remote : anchors?.get(copy.member);

      for (const specifier in copy.entries) {
        if (!ownTags.has(specifier)) ownTags.set(specifier, copy.tag);

        const tag =
          from === remote
            ? copy.tag
            : from !== undefined
              ? builds.get(from)?.tags.get(specifier)
              : shared.get(specifier);
        if (tag !== undefined && !resolved.has(specifier)) resolved.set(specifier, tag);
      }
    }
    if (resolved.size === 0) continue;

    // Its own build first: a remote running its whole family from itself is coherent by definition, and
    // that is where a self-serving copy has just put it.
    if (ships(ownTags, resolved)) continue;

    let witnessed = false;
    for (const [, build] of builds) {
      if (ships(build.tags, resolved)) {
        witnessed = true;
        break;
      }
    }

    if (!witnessed) {
      torn.push({
        remote,
        combination: [...resolved].map(([specifier, tag]) => `${specifier}@${tag}`).join(', '),
      });
    }
  }

  return torn;
}

const ships = (
  build: Map<Specifier, VersionName> | undefined,
  resolved: Map<Specifier, VersionName>
): boolean => {
  if (!build) return false;
  for (const [specifier, tag] of resolved) if (build.get(specifier) !== tag) return false;
  return true;
};

/**
 * The only remotes whose resolution pooling can have changed, and so the only ones worth checking: one it
 * anchored elsewhere, one consuming a member nothing publishes any more, or one holding a `scope` copy
 * without being islanded — which gate 1 makes impossible and is covered anyway, since it is the shape a tear
 * would take if that ever stopped holding. Everything else resolves the global mapping wholesale, exactly as
 * gate 2 witnessed it.
 *
 * `selfServed` is what each of them must serve itself, mirroring `rebuildMember` so the two cannot drift.
 */
function movedRemotes(
  members: PoolMember[],
  islanded: Islanded,
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
   * Runs after determine-shared-externals: per pool, gate 1 islands a remote that is version-incompatible on
   * any member and gate 2 decides, for every other remote, whether it may take the dedups determine granted
   * it. Emits nothing, only mutates `SharedExternal.versions`. See docs/version-resolver.md §"How pooling
   * resolves".
   *
   * `touched` (determine's re-elected externals per scope) gates the work: a pool no member of which was
   * re-elected resolves to what storage already holds, so a warm init does no per-member work at all. Because
   * `mark-pools-for-reelection` runs first, a touched pool is a *wholly* re-elected one, which is what makes
   * gate 1 sound.
   */
  return (touched?: TouchedExternals) => {
    const { useAutoExternalPooling, scopes } = poolableScopes(config, ports.sharedExternalsRepo);

    for (const scope of scopes) {
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
    // Below 2 members across 2 remotes there is nothing to coordinate; the per-external result is already
    // coherent.
    if (members.length < 2) return;

    const allRemotes = remotesInPool(members);
    if (allRemotes.length < 2) return;

    const islanded = islandedRemotes(members);
    const consumed = consumedMembers(members);
    const hosts = hostRemotes(members);

    // None of these three depend on `islanded`, so they survive every round of the coverage gate and every
    // re-assignment the no-tear loop asks for — and the healthy path never asks for them at all.
    const views: GateViews = {
      consumedSpecifiers: lazy(() => consumedSpecifiers(members)),
      acceptance: lazy(() => acceptanceTable(members, ports.versionCheck.isCompatible)),
      arrival: lazy(() => arrivalOrder(members)),
    };

    config.log.debug(
      3,
      `[${scope}][pool:${poolName}] ${members.length} members across ${allRemotes.length} remotes, incompatible={${[...islanded.keys()].join(', ') || '∅'}}\n` +
        members.map(m => `  - ${m.name}`).join('\n')
    );

    const assign = () => {
      const serving = assignServingBuilds(members, islanded, consumed, hosts, views);
      const basis = basisFor(members, islanded, serving);
      return { serving, basis, served: servedPerRemote(consumed, serving, basis) };
    };

    let { serving, basis, served } = assign();

    // Nothing to island and nothing reassigned: determine's verdicts already stand for every member, so
    // rebuilding them would write back what storage holds — unless the record still carries an anchor this
    // election did not grant, which has to be cleared or the map keeps honouring it.
    if (islanded.size === 0 && serving.size === 0 && !anyAnchorStored(members)) return;

    // A torn remote is islanded — self-serving a whole family is always coherent — and the assignment redone,
    // since taking a build away can move everyone who was deduping onto it. Terminates for the same reason
    // the coverage gate does: each round islands at least one more remote.
    for (;;) {
      const torn = findTornRemotes(members, islanded, basis, served, hosts);
      if (torn.length === 0) break;

      for (const { remote, combination } of torn)
        islanded.set(remote, { kind: 'torn', combination });
      ({ serving, basis, served } = assign());
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

    for (const [remote, cause] of islanded) {
      // What scopes is what this remote has a copy of, which in a ragged pool is fewer than the pool.
      const scoped = consumed.get(remote)?.length ?? 0;
      config.log.warn(3, `[${scope}][pool:${poolName}] ${islandWarning(remote, cause, scoped)}`);
    }

    for (const member of members) {
      const rebuilt = rebuildMember(member, islanded, served, basis.get(member.name));
      warnIfScopedOnly(poolName, member, rebuilt, islanded, scope);
      ports.sharedExternalsRepo.addOrUpdate(member.name, rebuilt, scope);
    }
  }

  /**
   * Gate 2: the witness first, then one build that serves a **superset** of what the remote consumes at
   * versions its own `requiredVersion` accepts, else it serves its whole family itself. No tag distance is
   * read anywhere, which is what stops a family split no build witnesses passing as benign patch drift.
   *
   * Repeats, and only after a round that scoped someone: scoping a remote removes it as a serving build,
   * which can leave a member unserved and push another remote onto its own build.
   */
  function assignServingBuilds(
    members: PoolMember[],
    islanded: Map<RemoteName, IslandCause>,
    consumed: Map<RemoteName, ExternalName[]>,
    hosts: Set<RemoteName>,
    views: GateViews
  ): ServingBuild {
    for (;;) {
      const bases = servingBuilds(members, islanded);

      // One build serves every member *and* every entrypoint anyone consumes, so the map hands every copy
      // that single build and gate 2 below would witness all of them. The healthy-portfolio path: no
      // per-build views, no acceptance table, no assignment, nothing written. Being the basis of every
      // member is not sufficient on its own — see `coversWholePool`.
      const distinct = new Set(bases.values());
      if (distinct.size === 1 && bases.size === members.length) {
        const sole = [...distinct][0]!;
        if (coversWholePool(members, sole, islanded)) return new Map();
      }

      const builds = liveBuilds(members, islanded);
      const shared = sharedTagPerSpecifier(members, islanded);
      const consumedSpec = views.consumedSpecifiers();

      const needAnchor = new Map<RemoteName, ExternalName[]>();
      const needSpecifiers = new Map<RemoteName, Set<Specifier>>();
      for (const [remote, wants] of consumed) {
        if (islanded.has(remote)) continue;
        if (isWitnessed(consumedSpec.get(remote) ?? [], shared, builds)) continue;
        needAnchor.set(remote, wants);
        needSpecifiers.set(remote, consumedSpec.get(remote) ?? new Set());
      }

      if (needAnchor.size === 0) return new Map();

      const acceptance = views.acceptance();
      const assignment = assignAnchors({
        builds,
        acceptance,
        consumedSpecifiers: needSpecifiers,
        consumedMembers: needAnchor,
        hosts,
        arrival: views.arrival(),
      });

      // A build somebody else dedups onto has to run its own copies of what it hands out, or the files it
      // serves would bind their peers against a different build one hop in (constraint 4).
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
            ...explainSelfServe(remote, wants, needSpecifiers.get(remote)!, { builds, acceptance }),
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
    islanded: Islanded,
    scope: string
  ): void {
    if (rebuilt.versions.some(v => v.action === 'share')) return;
    // Only the scoped copies really download their own file: a copy that lost the global mapping but
    // carries a `servedBy` still dedups, onto its anchor's build, and saying otherwise would be false.
    const consumers = new Set(
      rebuilt.versions.filter(v => v.action === 'scope').flatMap(v => v.remotes.map(r => r.name))
    ).size;
    if (consumers < 2) return;

    // An island took this member's last provider: its own warning already named the cause, and this one
    // would only restate the effect.
    const provider = member.external.versions.find(v => v.action === 'share');
    if (provider?.remotes.some(r => islanded.has(r.name))) return;

    config.log.warn(
      3,
      `[${scope}][pool:${poolName}] '${member.name}' is scoped-only — no coherent shared build provides it; ${consumers} remotes download their own copy.`
    );
  }

  // Island-or-defer at remote-copy granularity: islanded (or already-`scope`) copies self-serve; every
  // other copy keeps its base verdict, plus the build serving it whenever that is not the member's own
  // basis, so the map can point it at another origin's files. Scope versions group by each copy's real tag.
  //
  // `basis` is the copy the global mapping publishes; `undefined` means none is left and the member leaves
  // the shared set (constraint 15).
  function rebuildMember(
    member: PoolMember,
    islanded: Islanded,
    served: Served,
    basis: RemoteName | undefined
  ): SharedExternal {
    type Entry = {
      remote: RemoteName;
      tag: VersionName;
      host: boolean;
      action: SharedVersion['action'];
      meta: SharedVersionMeta;
    };

    let scoped: Entry[] = [];
    let clean: Entry[] = [];

    for (const version of member.external.versions) {
      for (const meta of version.remotes) {
        const entry: Entry = {
          remote: meta.name,
          tag: version.tag,
          host: version.host,
          action: version.action,
          meta,
        };
        (islanded.has(entry.remote) || entry.action === 'scope' ? scoped : clean).push(entry);
      }
    }

    // A copy about to self-serve runs its own file, so an anchor left on it from an earlier portfolio
    // would outlive the verdict it belonged to — and `servedBy` is persisted, read on the dynamic path as
    // "this build dedups onto somebody else" and there disqualifies the island as a serving build.
    for (const entry of scoped) delete entry.meta.servedBy;

    for (const entry of clean) {
      const build = served.get(entry.remote)?.get(member.name);
      if (build !== undefined) entry.meta.servedBy = build;
      else delete entry.meta.servedBy;
    }

    // No basis left: nothing publishes this member, so a copy that was resolving through the global mapping
    // has nowhere to go and self-serves. A copy with a `servedBy` is mapped explicitly and keeps its dedup —
    // sweeping it too is what made N providers of one tag download N copies (constraint 15).
    if (basis === undefined) {
      scoped = [...scoped, ...clean.filter(e => e.meta.servedBy === undefined)];
      clean = clean
        .filter(e => e.meta.servedBy !== undefined)
        .map(e => ({ ...e, action: 'skip' as const }));
    }

    // Basis first: `remotes[0]` is what the global mapping and a later re-election read as the serving copy,
    // and only a copy that runs its own build may be it.
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

    const byTag = (entries: Entry[], action: 'skip' | 'scope'): SharedVersion[] => {
      const versions = new Map<VersionName, SharedVersion>();
      for (const entry of entries) {
        const version = versions.get(entry.tag) ?? {
          tag: entry.tag,
          host: entry.host,
          action,
          remotes: [],
        };
        version.remotes.push(entry.meta);
        versions.set(entry.tag, version);
      }
      return [...versions.values()];
    };

    // Descending by tag, the order `commit()` guarantees and `determine` reads as "the latest" — see
    // store-remote-entry.version-order.spec.ts. Grouping by action would break it, and a later init
    // re-elects this record without `commit()` ever passing over it again.
    return {
      dirty: false,
      versions: [
        ...shareVersion,
        ...byTag(
          clean.filter(e => e.action === 'skip'),
          'skip'
        ),
        ...byTag(scoped, 'scope'),
      ].sort((a, b) => ports.versionCheck.compare(b.tag, a.tag)),
    };
  }
}

function islandWarning(remote: RemoteName, cause: IslandCause, scoped: number): string {
  // Deliberately worded apart: an incompatibility is a version the portfolio cannot honour, a coverage
  // self-serve is a family nothing shipped together. Three test helpers parse these sentences.
  switch (cause.kind) {
    case 'incompatible':
      return `'${remote}' is islanded: the resolver scoped its '${cause.member}@${cause.tag}', so all ${scoped} members it imports are scoped for it.`;
    case 'torn':
      return `'${remote}' serves its own family: the mapping would have handed it ${cause.combination}, which no build shipped together, so all ${scoped} members it imports are scoped for it.`;
    default: {
      const closest = cause.closest
        ? `closest is '${cause.closest}'`
        : 'no other build in the pool serves any of it';
      return `'${remote}' serves its own family: no shared build offers every entrypoint it imports at a version it accepts — '${cause.gap}' is the gap, ${closest}. All ${scoped} members it imports are scoped for it.`;
    }
  }
}
