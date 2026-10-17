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
import type { LoadActions } from 'lib/core/1.domain/remote-entry/load-actions.contract';
import { copiesByRemote, specifierCount } from 'lib/core/1.domain/pooling/builds';
import { buildPools, type PoolMember, type PoolName } from 'lib/core/1.domain/pooling/membership';
import { scopeHasPoolState } from 'lib/core/1.domain/pooling/pool-state';
import {
  committedView,
  coverFromMap,
  type CoverResult,
  type GateMiss,
  judgeRemote,
} from 'lib/core/1.domain/pooling/gate';
import { type CopyMove, movedRecord, renamedRecords } from 'lib/core/1.domain/pooling/records';
import { createAcceptsTag } from 'lib/core/1.domain/externals/compatibility';

export function createPoolDynamicExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo' | 'remoteInfoRepo' | 'versionCheck'>
): ForPoolingDynamicExternals {
  // Read per call so a port swapped after wiring is honoured.
  const accepts = createAcceptsTag(
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
      writeMoves(entry.name, names, moves, committed, pools, scope);
    }

    return Promise.resolve({ entry, actions: publicActions(actions) });
  };

  function judgeScope(
    remote: RemoteName,
    names: ReadonlySet<ExternalName>,
    actions: LoadActions,
    pools: ReadonlyMap<PoolName, PoolMember[]>,
    recordOrder: ExternalName[],
    scope: string
  ): Map<ExternalName, CopyMove> {
    const policy = { shareScope: scope, scopeUrlOf };
    const moves = new Map<ExternalName, CopyMove>();
    const selfServe = (members: PoolMember[], cause: PoolCause) => {
      for (const { name } of members) {
        actions[name]!.action = 'scope';
        delete actions[name]!.override;
        moves.set(name, { cause });
      }
    };

    for (const pool of pools.values()) {
      // Only the members this entry declares have an action to rewrite; the rest of the pool is context:
      // its committed tags are what the gate reads.
      const mine = pool.filter(member => names.has(member.name));
      if (mine.length === 0) continue;

      const shipped = copiesByRemote(pool);
      const view = committedView(pool, shipped, recordOrder, {
        shareScope: scope,
        without: remote,
      });
      const own = shipped.get(remote) ?? [];
      const verdict = judgeRemote(own, view, accepts);
      if (verdict !== 'global') {
        config.log.warn(8, `[${scope}] ${selfServeWarning(remote, verdict, specifierCount(own))}`);
        selfServe(mine, verdict.cause);
        continue;
      }

      const cover = coverFromMap(remote, mine, view, actions, policy);
      if (!('covers' in cover)) {
        if ('unmapped' in cover) warnUnmapped(scope, remote, cover.unmapped);
        else
          config.log.warn(
            8,
            `[${scope}] ${selfServeWarning(remote, coverMiss(cover), specifierCount(own))}`
          );
        // Half its family on the map's files and half on its own build would tear it.
        selfServe(mine, 'uncovered');
        continue;
      }
      for (const { name, toSkip, override } of cover.covers) {
        const action = actions[name]!;
        if (toSkip) {
          action.action = 'skip';
          moves.set(name, { fromMap: true });
        }
        if (Object.keys(override).length > 0) action.override = override;
      }
    }

    return moves;
  }

  // Writes the moves back so a reload rebuilds the map this delta publishes, not the one `update-cache`
  // recorded. The loaded remote's members are left dirty: the gate judged it against a map it could not
  // change, so the next init re-elects the scope with it, as a cold init of this record would.
  function writeMoves(
    remote: RemoteName,
    names: ReadonlySet<ExternalName>,
    moves: ReadonlyMap<ExternalName, CopyMove>,
    committed: shareScope,
    pools: ReadonlyMap<PoolName, PoolMember[]>,
    scope: string
  ): void {
    const written: Record<string, SharedExternal> = {};
    for (const [name, move] of moves)
      written[name] = movedRecord(committed[name]!, remote, move, ports.versionCheck.compare);
    for (const [name, record] of renamedRecords({ ...committed, ...written }, pools))
      written[name] = record;
    // A strict re-election throws on a pool the config refuses, so a strict page keeps the gate's verdicts.
    if (!config.strict.strictExternalCompatibility)
      for (const { name } of [...pools.values()].flat().filter(m => names.has(m.name)))
        written[name] = { ...(written[name] ?? committed[name]!), dirty: true };
    for (const [name, record] of Object.entries(written))
      ports.sharedExternalsRepo.addOrUpdate(name, record, scope);
  }

  function warnUnmapped(scope: string, remote: RemoteName, build: RemoteName): void {
    config.log.warn(
      8,
      `[${scope}][${remote}] '${build}' is not in the cache, so its files cannot be mapped.`
    );
  }
}

// `covered` only carries a skip from the cache update into the gate.
function publicActions(actions: LoadActions): SharedInfoActions {
  for (const action of Object.values(actions)) delete action.covered;
  return actions;
}

function poolableNames(entry: RemoteEntry, actions: LoadActions): Map<string, Set<ExternalName>> {
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

function coverMiss(
  cover: Exclude<CoverResult, { covers: unknown } | { unmapped: unknown }>
): GateMiss {
  if ('gap' in cover) return { cause: 'uncovered', specifier: cover.gap };
  return { cause: 'uncovered', ...cover.bound };
}

// Wording is pinned in `island-warnings.contract.spec.ts` alone; tools read islands from the record.
function selfServeWarning(remote: RemoteName, miss: GateMiss, imports: number): string {
  const where = `All ${imports} of its entrypoints are scoped for it.`;
  if (miss.cause === 'incompatible')
    return `'${remote}' is islanded: its range rejects '${miss.specifier}@${miss.tag}' of the committed map. ${where}`;
  if ('owner' in miss)
    return `'${remote}' serves its own family: committed build '${miss.owner}', whose files it would reach, resolves '${miss.specifier}' to another file than it would. ${where}`;
  if ('unshipped' in miss)
    return `'${remote}' serves its own family: no committed build shipped the map's combination for it. ${where}`;
  return `'${remote}' serves its own family: no committed build offers every entrypoint it imports at a version it accepts (gap '${miss.specifier}'). ${where}`;
}
