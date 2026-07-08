import type { ForPoolingSharedExternals } from '../../driver-ports/init/for-pooling-shared-externals.port';
import {
  type RemoteName,
  type SharedExternal,
  type SharedVersion,
  type shareScope,
} from 'lib/core/1.domain';
import { NFError } from 'lib/core/native-federation.error';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { ModeConfig } from '../../config/mode.contract';
import { resolvePoolMembership } from './pool-membership';
import { remotesInPool, versionForRemote } from './pool.util';
import type { PoolAnchor, PoolMember, PoolName, RemoteClassification } from './pool.types';

/** Shared empty tag list, so the common no-tag membership probe allocates nothing. */
const NO_TAGS: readonly string[] = [];

/** A member paired with determine's chosen (winning) tag for it and that tag's provider set. */
type PoolWinner = { member: PoolMember; tag: string; providers: Set<RemoteName> };

/**
 * Read determine-shared-externals' per-member result: the version it marked `share` (the winning
 * tag) and the remotes that provide it. Members always carry a `share` version here — pooled
 * externals live in non-strict scopes, are marked `dirty` on insert and cleaned by determine — so
 * the `?? ''` / `?? []` fallbacks are defensive only.
 */
function poolWinners(members: PoolMember[]): PoolWinner[] {
  return members.map(member => {
    const share = member.external.versions.find(v => v.action === 'share');
    return {
      member,
      tag: share?.tag ?? '',
      providers: new Set((share?.remotes ?? []).map(r => r.name)),
    };
  });
}

/**
 * Choose the anchor by coverage: the remote that provides the winning tag for the most members
 * (name-earliest breaks ties, deterministic and reload-stable). O(R·M), no `isCompatible`.
 *
 * The anchor may be **partial** — `tagPerMember` holds only the members it provides at the winning
 * tag; members it does not cover fall to scoped-only (orphan) via rebuildMember's `!anchorTag`
 * branch. When one remote covers every member (the "witness" case), tagPerMember is complete and
 * this reduces to the full-coverage anchor.
 *
 * Returns undefined only for a pool where no member has a winning provider; a real pool always
 * yields one.
 */
function selectCoverageAnchor(winners: PoolWinner[]): PoolAnchor | undefined {
  const coverage = new Map<RemoteName, number>();
  for (const w of winners)
    for (const r of w.providers) coverage.set(r, (coverage.get(r) ?? 0) + 1);
  if (coverage.size === 0) return undefined;

  const anchorRemote = [...coverage.keys()].sort(
    (a, b) => coverage.get(b)! - coverage.get(a)! || a.localeCompare(b)
  )[0]!;

  return {
    anchorRemote,
    tagPerMember: Object.fromEntries(
      winners.filter(w => w.providers.has(anchorRemote)).map(w => [w.member.name, w.tag])
    ),
  };
}

/**
 * Classify every remote in the pool by reading determine's stored per-version actions instead of
 * re-running `versionCheck.isCompatible`. Sound because every anchor tag equals that member's
 * winning tag, so determine already classified each version against it (`skip` ⇒ compatible ⇒
 * FOLLOW, `scope` ⇒ strict-incompatible ⇒ SCOPE).
 *
 * Same all-or-nothing per-remote verdict and `scope-incompat > scope-coverage > follow` precedence
 * as the old `classifyRemote`. O(R·M) map lookups, no equivalence-class grouping needed.
 */
function classifyPoolConservative(
  members: PoolMember[],
  anchor: PoolAnchor
): Map<RemoteName, RemoteClassification> {
  const classification = new Map<RemoteName, RemoteClassification>();

  for (const remote of remotesInPool(members)) {
    let coverageForced = false;
    let verdict: RemoteClassification = 'follow';

    for (const member of members) {
      const version = versionForRemote(member, remote);
      if (!version) continue; // remote does not use this member -> irrelevant

      const anchorTag = anchor.tagPerMember[member.name];
      if (!anchorTag) {
        // Remote uses this member but the anchor provides no build for it -> coverage-forced.
        coverageForced = true;
        continue;
      }
      if (version.tag === anchorTag) continue; // same tag as anchor -> compatible by construction

      // Different tag: anchorTag == member's winning tag, so determine already classified this
      // version relative to the winner. `scope` -> strict-incompatible (dominant, whole family).
      if (version.action === 'scope') {
        verdict = 'scope-incompat';
        break;
      }
      // action 'skip' (compatible, incl. non-strict-incompatible tolerated by determine) -> follow.
    }

    classification.set(
      remote,
      verdict === 'scope-incompat' ? 'scope-incompat' : coverageForced ? 'scope-coverage' : 'follow'
    );
  }

  classification.set(anchor.anchorRemote, 'follow');
  return classification;
}

export function createPoolSharedExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo'>
): ForPoolingSharedExternals {
  /**
   * Extra step (runs after determine-shared-externals): re-resolve pooled families so every
   * member of a pool resolves from ONE coherent source. A pool is a group of shared externals
   * (e.g. `@angular/*`) that must share the same anchor remote — same version *and* same build.
   *
   * This is a re-resolution layered on the per-external result; it emits nothing itself, it only
   * mutates the resolved `SharedExternal.versions` so that, per pool per scope: one anchor remote
   * provides `remotes[0]` of each member's `share` version, and every other remote is classified
   * once for the whole pool as FOLLOW (skip -> falls through to the anchor) or SCOPE (served from
   * its own build). All-or-nothing per remote.
   *
   * Inert unless `useAutoExternalPooling` is on or an external carries a remote `pool` tag. The
   * `strict` scope is never pooled.
   */
  return () => {
    const { useAutoExternalPooling } = config.profile;

    // has-pool early-out: with auto-pooling off and no remote having declared a `pool` tag, no
    // external can belong to a pool, so the whole scope walk below would resolve nothing. Skip it.
    // Auto-pooling on must never early-out — any scoped package is potentially poolable by scope.
    if (!useAutoExternalPooling && !ports.sharedExternalsRepo.hasSeenPoolTag()) {
      return Promise.resolve();
    }

    for (const scope of ports.sharedExternalsRepo.getScopes()) {
      if (ports.sharedExternalsRepo.scopeType(scope) === 'strict') continue;

      const sharedExternals = ports.sharedExternalsRepo.getFromScope(scope);

      try {
        for (const [poolName, members] of groupIntoPools(sharedExternals, useAutoExternalPooling)) {
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

  /** Group a scope's externals into pools via membership resolution. */
  function groupIntoPools(
    sharedExternals: shareScope,
    useAutoExternalPooling: boolean
  ): Map<PoolName, PoolMember[]> {
    const pools = new Map<PoolName, PoolMember[]>();

    for (const [name, external] of Object.entries(sharedExternals)) {
      // Collect declared pool tags without allocating when there are none (the common case under
      // auto-pooling): membership resolution still sees every tag, so conflict detection is intact.
      let tags: string[] | undefined;
      for (const version of external.versions) {
        for (const remote of version.remotes) {
          if (remote.pool) (tags ??= []).push(remote.pool);
        }
      }
      const poolName = resolvePoolMembership(
        name,
        tags ?? NO_TAGS,
        useAutoExternalPooling,
        config.log
      );
      if (!poolName) continue;

      const members = pools.get(poolName) ?? [];
      members.push({ name, external });
      pools.set(poolName, members);
    }

    return pools;
  }

  function poolFamily(poolName: PoolName, members: PoolMember[], scope: string): void {
    // A pool needs at least two members across at least two remotes to coordinate anything;
    // otherwise the per-external result from step 3 is already coherent.
    if (members.length < 2) return;

    const allRemotes = remotesInPool(members);
    if (allRemotes.length < 2) return;

    const anchor = selectCoverageAnchor(poolWinners(members));

    // A real pool (>=2 members, >=2 remotes) always yields a (possibly partial) anchor; this
    // guard is purely defensive.
    if (!anchor) return;

    const classification = classifyPoolConservative(members, anchor);

    const forcedScope = allRemotes.some(r => classification.get(r) !== 'follow');
    if (forcedScope && config.strict.strictExternalCompatibility) {
      config.log.error(
        3,
        `[${scope}][pool:${poolName}] Pool members are not all compatible with anchor '${anchor.anchorRemote}'.`
      );
      throw new NFError(`Could not pool '${poolName}' in scope ${scope}.`);
    }

    for (const member of members) {
      const rebuilt = rebuildMember(member, anchor, classification);
      warnIfScopedOnly(poolName, member.name, rebuilt, scope);
      ports.sharedExternalsRepo.addOrUpdate(member.name, rebuilt, scope);
    }
  }

  /**
   * An orphan member has no `share` version — no remote in the pool provides a build the family can
   * share, so every using remote downloads its own copy. Surface that: coherence for this member is
   * not achievable, only avoided-conflict.
   */
  function warnIfScopedOnly(
    poolName: PoolName,
    memberName: string,
    rebuilt: SharedExternal,
    scope: string
  ): void {
    if (rebuilt.versions.some(v => v.action === 'share')) return;
    const copies = rebuilt.versions.reduce((n, v) => n + v.remotes.length, 0);
    config.log.warn(
      3,
      `[${scope}][pool:${poolName}] '${memberName}' is scoped-only — no coherent shared build provides it; ${copies} remotes download their own copy.`
    );
  }

  /**
   * Rebuild a single member's versions around the anchor:
   *  - one `share` version on the anchor tag (anchor at remotes[0], plus FOLLOW remotes on that
   *    same tag);
   *  - `skip` versions for FOLLOW remotes on other tags, grouped by tag (they fall through to the
   *    global anchor);
   *  - one `scope` version holding every SCOPED remote's meta.
   *
   * When the anchor does not provide this member (orphan), there is no coherent shared build: the
   * member has *no* `share` version and every remote that uses it serves its own copy (scoped-only).
   */
  function rebuildMember(
    member: PoolMember,
    anchor: PoolAnchor,
    classification: Map<RemoteName, RemoteClassification>
  ): SharedExternal {
    const anchorTag = anchor.tagPerMember[member.name];
    const entries = member.external.versions.flatMap(v =>
      v.remotes.map(meta => ({ remote: meta.name, tag: v.tag, host: v.host, meta }))
    );

    // Orphan member: no shared build. Every using remote scopes its own copy (the scope version's
    // tag/host are inert — import-map generation reads only each remote's meta).
    if (!anchorTag) {
      return {
        dirty: false,
        versions:
          entries.length > 0
            ? [{ tag: entries[0]!.tag, host: false, action: 'scope', remotes: entries.map(e => e.meta) }]
            : [],
      };
    }

    const anchorMeta = entries.find(e => e.remote === anchor.anchorRemote && e.tag === anchorTag)!
      .meta;
    const anchorHost = member.external.versions.find(v => v.tag === anchorTag)?.host ?? false;

    // Whether a remote's entry for *this* member scopes its own copy. Incompatibility-forced remotes
    // scope their whole family with no dedup (deduping would inject a foreign build via a shared
    // intermediary). Coverage-forced remotes only scope members whose version differs from the shared
    // one — on the *same* version they dedup (fall through to the shared build, no extra download).
    const scopes = (e: { remote: RemoteName; tag: string }) => {
      const cls = classification.get(e.remote);
      return cls === 'scope-incompat' || (cls === 'scope-coverage' && e.tag !== anchorTag);
    };

    // share version: the anchor plus every non-scoping remote sitting on the anchor tag (FOLLOW
    // remotes, and coverage-forced remotes deduping their same-version copy).
    const shareOnAnchor = entries.filter(
      e => e.remote !== anchor.anchorRemote && e.tag === anchorTag && !scopes(e)
    );
    const shareVersion: SharedVersion = {
      tag: anchorTag,
      host: anchorHost,
      action: 'share',
      remotes: [anchorMeta, ...shareOnAnchor.map(e => e.meta)],
    };

    // skip versions: non-scoping remotes on other tags fall through to the shared build.
    const skipByTag = new Map<string, SharedVersion>();
    for (const e of entries) {
      if (e.tag === anchorTag || scopes(e)) continue;
      const version = skipByTag.get(e.tag) ?? {
        tag: e.tag,
        host: e.host,
        action: 'skip' as const,
        remotes: [],
      };
      version.remotes.push(e.meta);
      skipByTag.set(e.tag, version);
    }

    const scoped = entries.filter(e => scopes(e));
    const scopeVersion: SharedVersion[] =
      scoped.length > 0
        ? [{ tag: anchorTag, host: false, action: 'scope', remotes: scoped.map(e => e.meta) }]
        : [];

    return {
      dirty: false,
      versions: [shareVersion, ...skipByTag.values(), ...scopeVersion],
    };
  }
}
