import type { ForPoolingSharedExternals } from '../../driver-ports/init/for-pooling-shared-externals.port';
import type { ExternalName, RemoteName, SharedExternal, shareScope } from 'lib/core/1.domain';
import { NFError } from 'lib/core/native-federation.error';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { ModeConfig } from '../../config/mode.contract';
import { createAcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { type Copy, copiesByRemote, specifierCount } from 'lib/core/1.domain/pooling/builds';
import { elect, type PoolMiss, previousWinner } from 'lib/core/1.domain/pooling/election';
import type { PoolMember, PoolName } from 'lib/core/1.domain/pooling/membership';
import { type ElectionPlan, planElection } from 'lib/core/1.domain/pooling/plan';
import { memberRecord, type PlacedPool, placePool } from 'lib/core/1.domain/pooling/records';
import { createIsChunked } from './is-chunked';

export function createPoolSharedExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<
    DrivingContract,
    'sharedExternalsRepo' | 'versionCheck' | 'sharedChunksRepo' | 'scopedExternalsRepo'
  >
): ForPoolingSharedExternals {
  const { compare } = ports.versionCheck;
  const isChunked = createIsChunked(ports);

  // See docs/version-resolver.md §"How pooling resolves".
  return () => {
    const repo = ports.sharedExternalsRepo;
    for (const scope of repo.getScopes()) {
      const sharedExternals = repo.getFromScope(scope);
      try {
        const plan = planElection(sharedExternals, repo.scopeType(scope) !== 'strict');
        logPlan(plan, sharedExternals, scope);
        for (const [poolName, members] of plan.pools)
          for (const [name, record] of poolRecords(poolName, members, scope))
            repo.addOrUpdate(name, record, scope);
        for (const [name, external] of plan.stripped) repo.addOrUpdate(name, external, scope);
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

  function logPlan(plan: ElectionPlan, sharedExternals: shareScope, scope: string): void {
    if (plan.pools.size > 0) {
      const dirty = Object.values(sharedExternals).filter(external => external.dirty).length;
      config.log.debug(
        3,
        `[${scope}] re-electing ${plan.pools.size} pool(s): ${dirty} dirty external(s).`
      );
    }
    if (plan.stripped.size > 0)
      config.log.debug(
        3,
        `[${scope}] ${plan.stripped.size} external(s) left every pool; cleared their pool state for re-election.`
      );
    for (const name of plan.labelledAlone)
      config.log.debug(
        3,
        `[${scope}] '${name}' has a 'pool' label that joins no other external; likely a typo or a missing sibling.`
      );
  }

  function poolRecords(
    poolName: PoolName,
    members: PoolMember[],
    scope: string
  ): [ExternalName, SharedExternal][] {
    const election = elect({
      members,
      acceptsTag: createAcceptsTag(ports.versionCheck.isCompatible, compare),
      isChunked,
      compare,
      previousWinner: previousWinner(members),
      latestFirst: config.profile.latestSharedExternal,
    });
    const placed = placePool(election, poolName, members);
    report(poolName, members, placed, scope);
    return members.map(m => [
      m.name,
      { ...memberRecord(m, placed, compare), poolWinner: placed.winner },
    ]);
  }

  function report(
    poolName: PoolName,
    members: PoolMember[],
    placed: PlacedPool,
    scope: string
  ): void {
    const { misses } = placed;
    // A range rejecting the elected build is what this flag refuses; a coverage miss never is.
    const rejecting = [...misses]
      .filter(([, miss]) => miss?.cause === 'incompatible' && miss.strict)
      .map(([remote]) => remote);
    if (config.strict.strictExternalCompatibility && rejecting.length > 0) {
      config.log.error(
        3,
        `[${scope}][pool:${poolName}] version-incompatible remotes cannot be pooled: {${rejecting.join(', ')}}.`
      );
      throw new NFError(`Could not pool '${poolName}' in scope ${scope}.`);
    }

    const subpoolSizes = new Map<RemoteName, number>();
    for (const placement of placed.placements.values())
      if (placement.kind === 'subpool')
        subpoolSizes.set(placement.owner, (subpoolSizes.get(placement.owner) ?? 0) + 1);
    let shipped: Map<RemoteName, Copy[]> | undefined;
    for (const [remote, miss] of misses) {
      if (miss === undefined) {
        config.log.warn(
          3,
          `[${scope}][pool:${poolName}] '${remote}' keeps subpool '${remote}': the elected build would serve it, but ${subpoolSizes.get(remote)! - 1} other remote(s) in it need its build.`
        );
        continue;
      }
      shipped ??= copiesByRemote(members, isChunked);
      const counts = {
        imports: specifierCount(shipped.get(remote)!),
        subpoolSize: subpoolSizes.get(remote) ?? 0,
      };
      config.log.warn(
        3,
        `[${scope}][pool:${poolName}] ${missWarning(remote, miss, placed, counts)}`
      );
    }
  }
}

function missWarning(
  remote: RemoteName,
  miss: PoolMiss,
  placed: PlacedPool,
  counts: { imports: number; subpoolSize: number }
): string {
  // Wording is pinned in `island-warnings.contract.spec.ts` alone; tools read islands from the record.
  const { imports, subpoolSize } = counts;
  const placement = placed.placements.get(remote)!;
  const where =
    placement.kind === 'subpool' && placement.owner !== remote
      ? `It runs in subpool '${placement.owner}' for all ${imports} of its entrypoints.`
      : subpoolSize > 1
        ? `Its build serves subpool '${remote}': its ${imports} entrypoints and ${subpoolSize - 1} other remote(s).`
        : `All ${imports} of its entrypoints are scoped for it.`;

  if (miss.cause === 'incompatible')
    return `'${remote}' is islanded: its range rejects '${miss.member}@${miss.tag}' of the elected build '${placed.winner}'. ${where}`;
  if (miss.unshipped)
    return `'${remote}' serves its own family: no build shipped its entrypoints together at the elected versions (gap '${miss.gap}', closest '${placed.winner}'). ${where}`;
  return `'${remote}' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '${miss.gap}', closest '${placed.winner}'). ${where}`;
}
