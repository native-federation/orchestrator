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
import { classifyRemote } from './pool-classify';
import { resolvePoolMembership } from './pool-membership';
import { selectAnchor } from './pool-anchor';
import { remotesInPool } from './pool.util';
import type { PoolAnchor, PoolMember, PoolName, RemoteClassification } from './pool.types';

export function createPoolSharedExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'versionCheck' | 'sharedExternalsRepo'>
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
      const tags = external.versions.flatMap(v =>
        v.remotes.map(r => r.pool).filter((p): p is string => !!p)
      );
      const poolName = resolvePoolMembership(name, tags, useAutoExternalPooling, config.log);
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

    const anchor = selectAnchor(members, {
      versionCheck: ports.versionCheck,
      latestSharedExternal: config.profile.latestSharedExternal,
    });

    if (!anchor) {
      const msg = `[${scope}][pool:${poolName}] No single remote provides every pool member.`;
      if (config.strict.strictImportMap) {
        config.log.error(3, msg);
        throw new NFError(`Could not pool '${poolName}' in scope ${scope}.`);
      }
      config.log.warn(3, `${msg} Leaving externals unpooled.`);
      return;
    }

    const classification = classifyPool(members, anchor, allRemotes);

    const forcedScope = allRemotes.some(r => classification.get(r) === 'scope');
    if (forcedScope && config.strict.strictExternalCompatibility) {
      config.log.error(
        3,
        `[${scope}][pool:${poolName}] Pool members are not all compatible with anchor '${anchor.anchorRemote}'.`
      );
      throw new NFError(`Could not pool '${poolName}' in scope ${scope}.`);
    }

    for (const member of members) {
      ports.sharedExternalsRepo.addOrUpdate(
        member.name,
        rebuildMember(member, anchor, classification),
        scope
      );
    }
  }

  /** Classify every remote in the pool exactly once (the anchor always follows itself). */
  function classifyPool(
    members: PoolMember[],
    anchor: PoolAnchor,
    allRemotes: RemoteName[]
  ): Map<RemoteName, RemoteClassification> {
    const classification = new Map<RemoteName, RemoteClassification>();
    for (const remote of allRemotes) {
      classification.set(
        remote,
        remote === anchor.anchorRemote
          ? 'follow'
          : classifyRemote(remote, members, anchor, ports.versionCheck)
      );
    }
    return classification;
  }

  /**
   * Rebuild a single member's versions around the anchor:
   *  - one `share` version on the anchor tag (anchor at remotes[0], plus FOLLOW remotes on that
   *    same tag);
   *  - `skip` versions for FOLLOW remotes on other tags, grouped by tag (they fall through to the
   *    global anchor);
   *  - one `scope` version holding every SCOPED remote's meta.
   */
  function rebuildMember(
    member: PoolMember,
    anchor: PoolAnchor,
    classification: Map<RemoteName, RemoteClassification>
  ): SharedExternal {
    const anchorTag = anchor.tagPerMember[member.name]!;
    const entries = member.external.versions.flatMap(v =>
      v.remotes.map(meta => ({ remote: meta.name, tag: v.tag, host: v.host, meta }))
    );

    const anchorMeta = entries.find(e => e.remote === anchor.anchorRemote && e.tag === anchorTag)!
      .meta;
    const anchorHost = member.external.versions.find(v => v.tag === anchorTag)?.host ?? false;

    const followOnAnchor = entries.filter(
      e =>
        e.remote !== anchor.anchorRemote &&
        e.tag === anchorTag &&
        classification.get(e.remote) === 'follow'
    );
    const shareVersion: SharedVersion = {
      tag: anchorTag,
      host: anchorHost,
      action: 'share',
      remotes: [anchorMeta, ...followOnAnchor.map(e => e.meta)],
    };

    const skipByTag = new Map<string, SharedVersion>();
    for (const e of entries) {
      if (e.tag === anchorTag || classification.get(e.remote) !== 'follow') continue;
      const version = skipByTag.get(e.tag) ?? {
        tag: e.tag,
        host: e.host,
        action: 'skip' as const,
        remotes: [],
      };
      version.remotes.push(e.meta);
      skipByTag.set(e.tag, version);
    }

    const scoped = entries.filter(e => classification.get(e.remote) === 'scope');
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
