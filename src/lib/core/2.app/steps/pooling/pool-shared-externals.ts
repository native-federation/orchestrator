import type { ForPoolingSharedExternals } from '../../driver-ports/init/for-pooling-shared-externals.port';
import type { RemoteName, SharedExternal, SharedVersion } from 'lib/core/1.domain';
import { NFError } from 'lib/core/native-federation.error';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { ModeConfig } from '../../config/mode.contract';
import { buildPools } from './pool-graph';
import { remotesInPool, versionForRemote } from './pool.util';
import type { PoolAnchor, PoolMember, PoolName, RemoteClassification } from './pool.types';

type PoolWinner = { member: PoolMember; tag: string; providers: Set<RemoteName> };

// The `?? '' / ?? []` fallbacks are defensive only: pooled externals live in non-strict scopes and
// always carry a `share` version by the time determine-shared-externals has run.
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

// Anchor = remote providing the winning tag for the most members (name-earliest breaks ties, for
// reload-stability). The anchor may be partial: members it does not cover become orphans
// (scoped-only) via rebuildMember's `!anchorTag` branch.
function selectCoverageAnchor(winners: PoolWinner[]): PoolAnchor | undefined {
  const coverage = new Map<RemoteName, number>();
  for (const winner of winners)
    for (const remote of winner.providers) coverage.set(remote, (coverage.get(remote) ?? 0) + 1);
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

// Classify every remote by reading determine's stored per-version actions rather than re-running
// isCompatible. Sound because every anchor tag equals that member's winning tag, so determine has
// already classified each version against it (`skip` ⇒ compatible ⇒ follow, `scope` ⇒
// strict-incompatible ⇒ scope). Precedence: scope-incompat > scope-coverage > follow.
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
      if (!version) continue;

      const anchorTag = anchor.tagPerMember[member.name];
      if (!anchorTag) {
        // Remote uses this member but the anchor provides no build for it.
        coverageForced = true;
        continue;
      }
      if (version.tag === anchorTag) continue;

      // Different tag against the winning tag: `scope` means strict-incompatible, which dominates
      // and forces the whole family to scope. `skip` is tolerated and stays a follow.
      if (version.action === 'scope') {
        verdict = 'scope-incompat';
        break;
      }
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
   * Runs after determine-shared-externals: re-resolve each pool (e.g. `@framework/*`) so every member
   * resolves from ONE anchor remote — same version and same build. Layered on the per-external
   * result; emits nothing, only mutates `SharedExternal.versions`. See docs/version-resolver.md.
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

    const anchor = selectCoverageAnchor(poolWinners(members));
    if (!anchor) return; // defensive: a real pool always yields one

    const classification = classifyPoolConservative(members, anchor);

    config.log.debug(
      3,
      `[${scope}][pool:${poolName}] members=[${members.map(m => m.name).join(', ')}], anchor=${anchor.anchorRemote}, remotes={${allRemotes.map(r => `${r}:${classification.get(r)}`).join(', ')}}`
    );

    // Only a genuine version incompatibility (`scope-incompat`) aborts under strict mode. A
    // `scope-coverage` remote — one that merely uses a member the anchor does not ship — is a
    // benign coverage gap (a ragged portfolio), not a conflict, so it resolves scoped just as it
    // does outside strict mode. (In strict mode determine-shared-externals already throws on real
    // incompatibilities, so this guard is defensive.)
    const incompatForced = allRemotes.some(r => classification.get(r) === 'scope-incompat');
    if (incompatForced && config.strict.strictExternalCompatibility) {
      config.log.error(
        3,
        `[${scope}][pool:${poolName}] A remote is version-incompatible with anchor '${anchor.anchorRemote}'.`
      );
      throw new NFError(`Could not pool '${poolName}' in scope ${scope}.`);
    }

    for (const member of members) {
      const rebuilt = rebuildMember(member, anchor, classification);
      warnIfScopedOnly(poolName, member.name, rebuilt, scope);
      ports.sharedExternalsRepo.addOrUpdate(member.name, rebuilt, scope);
    }
  }

  // Warn when a member is scoped-only (no `share` version): no remote provides a build the family
  // can share, so every using remote downloads its own copy — coherence is not achievable here.
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

  function rebuildMember(
    member: PoolMember,
    anchor: PoolAnchor,
    classification: Map<RemoteName, RemoteClassification>
  ): SharedExternal {
    const anchorTag = anchor.tagPerMember[member.name];
    const entries = member.external.versions.flatMap(v =>
      v.remotes.map(meta => ({ remote: meta.name, tag: v.tag, host: v.host, meta }))
    );

    // Orphan member: no shared build, every using remote scopes its own copy. The scope version's
    // tag/host are inert here — import-map generation reads only each remote's meta.
    if (!anchorTag) {
      return {
        dirty: false,
        versions:
          entries.length > 0
            ? [
                {
                  tag: entries[0]!.tag,
                  host: false,
                  action: 'scope',
                  remotes: entries.map(e => e.meta),
                },
              ]
            : [],
      };
    }

    const anchorMeta = entries.find(
      e => e.remote === anchor.anchorRemote && e.tag === anchorTag
    )!.meta;
    const anchorHost = member.external.versions.find(v => v.tag === anchorTag)?.host ?? false;

    // Incompatibility-forced remotes scope their whole family with no dedup: deduping a same-version
    // sibling would inject a foreign build via a shared intermediary. Coverage-forced remotes scope
    // only members that differ from the shared version; on the same version they dedup.
    const scopes = (e: { remote: RemoteName; tag: string }) => {
      const cls = classification.get(e.remote);
      return cls === 'scope-incompat' || (cls === 'scope-coverage' && e.tag !== anchorTag);
    };

    const shareOnAnchor = entries.filter(
      e => e.remote !== anchor.anchorRemote && e.tag === anchorTag && !scopes(e)
    );
    const shareVersion: SharedVersion = {
      tag: anchorTag,
      host: anchorHost,
      action: 'share',
      remotes: [anchorMeta, ...shareOnAnchor.map(e => e.meta)],
    };

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
