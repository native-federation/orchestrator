import type { ForPoolingDynamicExternals } from '../../driver-ports/init/for-pooling-dynamic-externals.port';
import type { ModeConfig } from '../../config/mode.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import {
  type ExternalName,
  GLOBAL_SCOPE,
  type PoolCause,
  type RemoteEntry,
  type RemoteName,
  STRICT_SCOPE,
  type SharedExternal,
  type SharedInfoActions,
  type shareScope,
} from 'lib/core/1.domain';
import { copiesByRemote } from 'lib/core/1.domain/pooling/builds';
import { buildPools, type PoolMember, type PoolName } from 'lib/core/1.domain/pooling/membership';
import { renamedRecords, scopeHasPoolState } from 'lib/core/1.domain/pooling/pool-state';
import {
  committedView,
  type CopyMove,
  coverFromMap,
  type GateMiss,
  judgeRemote,
  movedRecord,
} from 'lib/core/1.domain/pooling/gate';
import { acceptsTag } from 'lib/core/1.domain/externals/compatibility';

export function createPoolDynamicExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo' | 'remoteInfoRepo' | 'versionCheck'>
): ForPoolingDynamicExternals {
  // Read per call so a port swapped after wiring is honoured.
  const accepts = acceptsTag(
    (tag, range) => ports.versionCheck.isCompatible(tag, range),
    (a, b) => ports.versionCheck.compare(a, b)
  );
  const scopeUrlOf = (remote: RemoteName) => ports.remoteInfoRepo.tryGet(remote).get()?.scopeUrl;

  // The committed map is immutable, so this only rewrites the loaded remote's own actions and copies, never
  // another remote's. See docs/version-resolver.md §"Scope and dynamic init".
  return ({ entry, actions }) => {
    for (const [scope, names] of poolableNames(entry, actions)) {
      // A label anywhere in the committed scope forms pools this entry is subject to — its own label is not
      // required, and the pool covers the whole external, this entry's copies included.
      const committed = ports.sharedExternalsRepo.getFromScope(scope);
      if (!scopeHasPoolState(committed)) continue;

      const { pools } = buildPools(committed);
      const moves = judgeScope(entry.name, names, actions, pools, Object.keys(committed), scope);
      writeMoves(entry.name, moves, committed, pools, scope);
    }

    return Promise.resolve({ entry, actions });
  };

  // Rewrites the loaded remote's actions pool by pool and returns how its copies move in the record.
  function judgeScope(
    remote: RemoteName,
    names: ReadonlySet<ExternalName>,
    actions: SharedInfoActions,
    pools: ReadonlyMap<PoolName, PoolMember[]>,
    recordOrder: ExternalName[],
    scope: string
  ): Map<ExternalName, CopyMove> {
    const policy = { shareScope: scope, selfFill: maySelfFill(scope), scopeUrlOf };
    const moves = new Map<ExternalName, CopyMove>();
    const selfServe = (members: PoolMember[], cause: PoolCause) => {
      for (const { name } of members) {
        actions[name]!.action = 'scope';
        delete actions[name]!.override;
        delete actions[name]!.covered;
        moves.set(name, { cause });
      }
    };

    for (const pool of pools.values()) {
      // Only the members this entry declares have an action to rewrite; the rest of the pool is context:
      // its committed tags are what the gate reads.
      const mine = pool.filter(member => names.has(member.name));
      if (mine.length === 0) continue;

      const shipped = copiesByRemote(pool);
      const view = committedView(pool, shipped, recordOrder, remote);
      const verdict = judgeRemote(shipped.get(remote) ?? [], view, accepts);
      if (verdict !== 'global') {
        config.log.warn(8, `[${scope}] ${selfServeWarning(remote, verdict, mine.length)}`);
        selfServe(mine, verdict.cause);
        continue;
      }

      const cover = coverFromMap(remote, mine, view, actions, policy);
      if ('unmapped' in cover) {
        // Half its family on the map's files and half on its own build would tear it.
        warnUnmapped(scope, remote, cover.unmapped);
        selfServe(mine, 'uncovered');
        continue;
      }
      for (const { name, toSkip, covered, override } of cover.covers) {
        const action = actions[name]!;
        if (toSkip) {
          action.action = 'skip';
          moves.set(name, { fromMap: true });
        }
        action.covered = covered;
        if (Object.keys(override).length > 0) action.override = override;
      }
    }

    return moves;
  }

  // Writes the moves back so a reload rebuilds the map this delta publishes, not the one `update-cache`
  // recorded.
  function writeMoves(
    remote: RemoteName,
    moves: ReadonlyMap<ExternalName, CopyMove>,
    committed: shareScope,
    pools: ReadonlyMap<PoolName, PoolMember[]>,
    scope: string
  ): void {
    const written: Record<string, SharedExternal> = {};
    for (const [name, move] of moves) {
      written[name] = movedRecord(committed[name]!, remote, move, ports.versionCheck.compare);
      ports.sharedExternalsRepo.addOrUpdate(name, written[name], scope);
    }
    const merged = { ...committed, ...written };
    for (const [name, record] of renamedRecords(merged, pools))
      ports.sharedExternalsRepo.addOrUpdate(name, record, scope);
  }

  // Whether an entrypoint a skip leaves uncovered may come from the remote's own build: the coverage policies
  // refuse it, and so does the next page of a named scope, for a skip-only package, under `strictImportMap`.
  function maySelfFill(scope: string): boolean {
    if (config.strict.strictEntryPointCoverage || config.profile.scopeUncoveredEntrypoints)
      return false;
    return scope === GLOBAL_SCOPE || !config.strict.strictImportMap;
  }

  function warnUnmapped(scope: string, remote: RemoteName, build: RemoteName): void {
    config.log.warn(
      8,
      `[${scope}][${remote}] '${build}' is not in the cache, so its files cannot be mapped.`
    );
  }
}

// The poolable singletons whose actions may be rewritten, per share scope; membership comes from the record.
function poolableNames(
  entry: RemoteEntry,
  actions: SharedInfoActions
): Map<string, Set<ExternalName>> {
  const declared = new Map<string, Set<ExternalName>>();
  for (const external of entry.shared ?? []) {
    const name = external.packageName;
    if (!external.singleton || !actions[name]) continue;
    if (external.shareScope === STRICT_SCOPE) continue;

    const scope = external.shareScope ?? GLOBAL_SCOPE;
    let names = declared.get(scope);
    if (!names) declared.set(scope, (names = new Set()));
    names.add(name);
  }
  return declared;
}

// Wording is pinned in `island-warnings.contract.spec.ts` alone; tools read islands from the record.
function selfServeWarning(remote: RemoteName, miss: GateMiss, members: number): string {
  const where = `All ${members} of its members are scoped for it.`;
  if (miss.cause === 'incompatible')
    return `'${remote}' is islanded: its range rejects '${miss.specifier}@${miss.tag}' of the committed map. ${where}`;
  if ('unshipped' in miss)
    return `'${remote}' serves its own family: no committed build shipped the map's combination for it. ${where}`;
  return `'${remote}' serves its own family: no committed build offers every entrypoint it imports at a version it accepts (gap '${miss.specifier}'). ${where}`;
}
