import type { ForPoolingSharedExternals } from '../../driver-ports/init/for-pooling-shared-externals.port';
import type { TouchedExternals } from '../../driver-ports/init/for-determining-shared-externals.port';
import type {
  PoolCause,
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
import { acceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { arrivalOrder, hostRemotes } from 'lib/core/1.domain/pooling/views';
import { electVariants, type Election } from 'lib/core/1.domain/pooling/election';
import { buildPools, type PoolMember, type PoolName } from 'lib/core/1.domain/pooling/membership';
import { type Specifier, SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import { poolableScopes, syncPoolNames } from './pool.util';

type Route = { kind: 'global' } | { kind: 'subpool'; build: RemoteName } | { kind: 'own' };

// Why a remote missed round 1, worded for the log and stored as `poolCause` on what it scopes.
// `with`: the specifiers no build shipped together with `gap`, for a remote the map serves but no build witnesses.
type Miss = { cause: PoolCause; gap: string; strict: boolean; with?: Specifier[] };

export function createPoolSharedExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo' | 'versionCheck'>
): ForPoolingSharedExternals {
  // See docs/version-resolver.md §"How pooling resolves". A pool is marked dirty as a whole, so one with no
  // touched member is what storage already holds.
  return (touched?: TouchedExternals) => {
    const inTouched = (scope: string) => !touched || touched.has(scope);
    for (const [scope, sharedExternals] of poolableScopes(ports.sharedExternalsRepo, inTouched)) {
      const touchedInScope = touched?.get(scope);

      try {
        const { pools, lonelyTags } = buildPools(sharedExternals);
        for (const name of lonelyTags)
          config.log.warn(
            3,
            `[${name}] declares a 'pool' tag but no other external joined its pool; likely a typo or a missing sibling.`
          );
        const rebuilt = new Set<PoolName>();
        for (const [poolName, members] of pools) {
          if (touchedInScope && !members.some(m => touchedInScope.has(m.name))) continue;
          try {
            electPool(poolName, members, scope);
          } catch (error) {
            if (error instanceof NFError) throw error;
            placeSafely(poolName, members, scope, error);
          }
          rebuilt.add(poolName);
        }
        syncPoolNames(sharedExternals, pools, ports.sharedExternalsRepo, scope, rebuilt);
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

  function electPool(poolName: PoolName, members: PoolMember[], scope: string): void {
    const hosts = hostRemotes(members);
    const election = electVariants({
      members,
      acceptsTag: acceptsTag(ports.versionCheck.isCompatible, ports.versionCheck.compare),
      hosts,
      arrival: arrivalOrder(members),
      compare: ports.versionCheck.compare,
      previous: previousWinner(members),
      latestFirst: config.profile.latestSharedExternal,
    });

    config.log.debug(
      3,
      `[${scope}][pool:${poolName}] round 1: '${election.winner}' serves ${election.global.size}` +
        election.subpools.map(p => `; subpool '${p.build}' serves ${p.members.length}`).join('') +
        (election.alone.length ? `; alone: {${election.alone.join(', ')}}` : '')
    );

    const routes = routesOf(election);
    const misses = new Map<RemoteName, Miss>();
    for (const remote of routes.keys()) {
      if (election.global.has(remote)) continue;
      const miss = election.missOf(remote);
      if (miss === undefined) {
        const others = election.subpools.find(p => p.build === remote)!.members.length - 1;
        config.log.warn(
          3,
          `[${scope}][pool:${poolName}] '${remote}' keeps subpool '${remote}': the elected build would serve it, but ${others} other remote(s) in it need its build.`
        );
        continue;
      }
      misses.set(
        remote,
        'rejected' in miss
          ? {
              cause: 'incompatible',
              gap: `${miss.rejected.member}@${miss.rejected.tag}`,
              strict: miss.rejected.strict,
            }
          : 'unwitnessed' in miss
            ? {
                cause: 'uncovered',
                gap: miss.unwitnessed.gap,
                with: miss.unwitnessed.with,
                strict: false,
              }
            : { cause: 'uncovered', gap: miss.gap, strict: false }
      );
    }

    // A range rejecting the elected build is what this flag refuses; a coverage miss never is.
    const rejecting = [...misses].filter(([, miss]) => miss.strict).map(([remote]) => remote);
    if (config.strict.strictExternalCompatibility && rejecting.length > 0) {
      config.log.error(
        3,
        `[${scope}][pool:${poolName}] version-incompatible remotes cannot be pooled: {${rejecting.join(', ')}}.`
      );
      throw new NFError(`Could not pool '${poolName}' in scope ${scope}.`);
    }

    for (const [remote, miss] of misses)
      config.log.warn(
        3,
        `[${scope}][pool:${poolName}] ${missWarning(remote, miss, election, routes.get(remote)!, members)}`
      );

    for (const member of members) {
      ports.sharedExternalsRepo.addOrUpdate(
        member.name,
        {
          ...rebuildMember(poolName, member, election, routes, misses, hosts),
          poolWinner: election.winner,
        },
        scope
      );
    }
  }

  // A failure elects one pool by the one placement that cannot tear: the host's build, else the first
  // arrival's, stays global and every other remote serves its whole family itself. It stores no `poolWinner`:
  // it was not an election, so it must not break the next one's tie.
  function placeSafely(poolName: PoolName, members: PoolMember[], scope: string, error: unknown) {
    const hosts = hostRemotes(members);
    const remotes = [...arrivalOrder(members).keys()];
    const winner = remotes.find(r => hosts.has(r)) ?? remotes[0];
    config.log.error(
      3,
      `[${scope}][pool:${poolName}] could not elect the pool; only '${winner}' resolves globally, every other remote serves its own family.`,
      error
    );
    if (winner === undefined) return;

    const coverage = new SpecifierTags();
    for (const member of members)
      for (const version of member.external.versions)
        for (const meta of version.remotes)
          if (meta.name === winner)
            for (const s in meta.entries) if (!coverage.has(s)) coverage.set(s, version.tag);

    const alone = remotes.filter(r => r !== winner);
    const election: Election = {
      winner,
      coverage,
      global: new Set([winner]),
      subpools: [],
      alone,
      agreeing: new Set(),
      tagOf: s => coverage.tagOf(s),
      missOf: () => undefined,
    };
    const routes = routesOf(election);
    const misses = new Map<RemoteName, Miss>(
      alone.map(r => [r, { cause: 'uncovered', gap: '', strict: false }])
    );
    for (const member of members)
      ports.sharedExternalsRepo.addOrUpdate(
        member.name,
        rebuildMember(poolName, member, election, routes, misses, hosts),
        scope
      );
  }

  function routesOf(election: Election): Map<RemoteName, Route> {
    const routes = new Map<RemoteName, Route>();
    for (const remote of election.global) routes.set(remote, { kind: 'global' });
    for (const { build, members } of election.subpools)
      for (const remote of members)
        routes.set(remote, remote === build ? { kind: 'own' } : { kind: 'subpool', build });
    for (const remote of election.alone) routes.set(remote, { kind: 'own' });
    return routes;
  }

  // One member's record from the election, one row per `(tag, action)`; see docs/version-resolver.md
  // §"How the verdicts land in the record and the map".
  function rebuildMember(
    poolName: PoolName,
    member: PoolMember,
    election: Election,
    routes: Map<RemoteName, Route>,
    misses: Map<RemoteName, Miss>,
    hosts: ReadonlySet<RemoteName>
  ): SharedExternal {
    // A package can ship only secondary entrypoints (`material/table` without `material`), so its published
    // tag is whatever round 1 serves any of its entrypoints at.
    // An entrypoint round 1 does not serve itself still has its package's tag, which is what rule 5 compares.
    let published: VersionName | undefined;
    let pinned: VersionName | undefined;
    for (const version of member.external.versions)
      for (const meta of version.remotes)
        for (const s in meta.entries) {
          published ??= election.coverage.get(s);
          pinned ??= election.tagOf(s);
        }
    const builds = new Set(election.subpools.map(p => p.build));
    const rows = new Map<string, SharedVersion>();

    const place = (tag: VersionName, action: SharedVersion['action'], meta: SharedVersionMeta) => {
      const key = `${tag}|${action}`;
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { tag, host: false, action, remotes: [] }));
      // The winner's copy leads its row: `remotes[0]` is the basis the global map publishes.
      if (meta.name === election.winner) row.remotes.unshift(meta);
      else row.remotes.push(meta);
      if (meta.name === election.winner && hosts.has(meta.name)) row.host = true;
    };

    for (const version of member.external.versions) {
      for (const stored of version.remotes) {
        const { servedBy: _servedBy, poolCause: _poolCause, ...meta } = stored;
        const route = routes.get(meta.name)!;
        const runs = route.kind === 'subpool' ? route.build : meta.name;
        // Rule 5: a build agreeing with round 1 takes its files wherever round 1 publishes this package.
        const global =
          route.kind === 'global' || (election.agreeing.has(runs) && pinned !== undefined);

        if (global) place(version.tag, version.tag === published ? 'share' : 'skip', meta);
        else if (route.kind === 'subpool' || builds.has(meta.name))
          place(version.tag, 'skip', { ...meta, servedBy: runs });
        else place(version.tag, 'scope', { ...meta, poolCause: misses.get(meta.name)!.cause });
      }
    }

    // Newest tag first, as `commit()` orders a record; within a tag `share`, `skip`, then `scope`.
    const order = { share: 0, skip: 1, scope: 2 };
    const versions = [...rows.values()].sort(
      (a, b) => ports.versionCheck.compare(b.tag, a.tag) || order[a.action] - order[b.action]
    );

    return { dirty: false, poolName, versions };
  }
}

// A member that joined since carries no winner yet; only two stored winners that conflict void it.
function previousWinner(members: PoolMember[]): RemoteName | undefined {
  const winners = new Set(members.flatMap(m => m.external.poolWinner ?? []));
  const [winner] = winners;
  if (winners.size !== 1) return undefined;
  const ships = members.some(m =>
    m.external.versions.some(v => v.remotes.some(r => r.name === winner))
  );
  return ships ? winner : undefined;
}

function missWarning(
  remote: RemoteName,
  miss: Miss,
  election: Election,
  route: Route,
  members: PoolMember[]
): string {
  // Wording is pinned in `island-warnings.contract.spec.ts` alone; tools read islands from the record.
  const imports = members.filter(m =>
    m.external.versions.some(v => v.remotes.some(r => r.name === remote))
  ).length;
  const serves = election.subpools.find(p => p.build === remote)?.members.length ?? 0;
  const where =
    route.kind === 'subpool'
      ? `It runs in subpool '${route.build}': all ${imports} members it imports come from that build.`
      : serves > 1
        ? `Its build runs subpool '${remote}' for its ${imports} members and ${serves - 1} other remote(s).`
        : election.agreeing.has(remote)
          ? `It takes the elected files where its versions match and serves the rest of its ${imports} members itself.`
          : `All ${imports} members it imports are scoped for it.`;

  const at = (s: Specifier) => `'${s}@${election.tagOf(s)!}'`;
  if (miss.cause === 'incompatible')
    return `'${remote}' is islanded: its range rejects '${miss.gap}' of the elected build '${election.winner}'. ${where}`;
  if (miss.with)
    return `'${remote}' serves its own family: no build shipped ${miss.with.map(at).join(', ')} together with ${at(miss.gap)} — '${miss.gap}' is the gap, closest is '${election.winner}'. ${where}`;
  return `'${remote}' serves its own family: no elected build offers every entrypoint it imports at a version it accepts — '${miss.gap}' is the gap, closest is '${election.winner}'. ${where}`;
}
