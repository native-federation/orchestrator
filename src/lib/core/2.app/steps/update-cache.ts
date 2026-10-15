import type { ForUpdatingCache } from '../driver-ports/init/for-updating-cache';
import {
  type RemoteEntry,
  type DenseSharedInfo,
  type RemoteName,
  type SharedVersionAction,
  type SharedVersionMeta,
  GLOBAL_SCOPE,
} from 'lib/core/1.domain';
import type { LoadActions } from 'lib/core/1.domain/remote-entry/load-actions.contract';
import { createAcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { addRemoteToVersion } from 'lib/core/1.domain/externals/basis';
import { isPooled, loadSplitsPackage } from 'lib/core/1.domain/externals/serving';
import { type Claim, committedClaims } from 'lib/core/1.domain/externals/claims';
import { packageOf, type Specifier } from 'lib/core/1.domain/externals/specifier';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import * as _path from 'lib/utils/path';
import { NFError } from 'lib/core/native-federation.error';
import type { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { createStoreRemoteEntry, type SharedExternalContext } from './store-remote-entry';

type Pending = { external: DenseSharedInfo; ctx: SharedExternalContext };

type Served = Map<Specifier, Claim>;

type Rejection = { item: Pending; specifier: Specifier; claim: Claim };

// share: the remote's build opens the package; skip: it runs the build the map serves it from; scope: its own
// build beside the map (partlyServed: the map serves some of it, or all of it from two builds).
type Decision =
  | { action: 'share' }
  | { action: 'scope'; partlyServed: boolean }
  | { action: 'skip'; files: Map<Specifier, SharedVersionMeta> };

export function createUpdateCache(
  config: LoggingConfig & ModeConfig,
  ports: Pick<
    DrivingContract,
    | 'remoteInfoRepo'
    | 'sharedExternalsRepo'
    | 'scopedExternalsRepo'
    | 'sharedChunksRepo'
    | 'versionCheck'
  >
): ForUpdatingCache {
  const storeRemoteEntry = createStoreRemoteEntry(config, ports, 8);
  // Read per call so a port swapped after wiring is honoured.
  const accepts = createAcceptsTag(
    (tag, range) => ports.versionCheck.isCompatible(tag, range),
    (a, b) => ports.versionCheck.compare(a, b)
  );

  // The import map is committed, so each package the remote shares runs wholly from one build; see
  // docs/version-resolver.md §"Scope and dynamic init".
  return remoteEntry => {
    try {
      // Collected before any copy is stored, so every decision reads the record the committed map came from.
      const pending: Pending[] = [];
      storeRemoteEntry(remoteEntry, (_, external, ctx) => pending.push({ external, ctx }));
      const decisions = decidePackages(remoteEntry, pending);

      const actions: LoadActions = {};
      for (const item of pending)
        actions[item.external.packageName] = applyDecision(remoteEntry, item, decisions.get(item)!);

      return Promise.resolve({ entry: remoteEntry, actions });
    } catch (error) {
      return Promise.reject(error);
    }
  };

  function decidePackages(remoteEntry: RemoteEntry, pending: Pending[]): Map<Pending, Decision> {
    const decisions = new Map<Pending, Decision>();
    const servedIn = servedPerScope(remoteEntry);
    for (const group of groupByPackage(pending)) {
      // The strict scope shares every version side by side.
      const decision =
        group[0]!.ctx.scopeType === 'strict'
          ? ({ action: 'share' } as const)
          : decidePackage(remoteEntry, group, servedIn(group[0]!.external.shareScope));
      for (const item of group) decisions.set(item, decision);
    }
    scopeOpenedPackages(decisions);
    return decisions;
  }

  function groupByPackage(pending: Pending[]): Pending[][] {
    const packages = new Map<string, Pending[]>();
    for (const item of pending) {
      const { shareScope, packageName } = item.external;
      const key = `${shareScope ?? GLOBAL_SCOPE}\0${packageOf(packageName)}`;
      const group = packages.get(key);
      if (group) group.push(item);
      else packages.set(key, [item]);
    }
    return [...packages.values()];
  }

  function servedPerScope(remoteEntry: RemoteEntry): (shareScope: string | undefined) => Served {
    const servedIn = new Map<string, Served>();
    return shareScope => {
      const scope = shareScope ?? GLOBAL_SCOPE;
      let served = servedIn.get(scope);
      if (!served) {
        const record = Object.entries(ports.sharedExternalsRepo.getFromScope(shareScope));
        served = committedClaims(record, { shareScope: scope, without: remoteEntry.name });
        servedIn.set(scope, served);
      }
      return served;
    };
  }

  function scopeOpenedPackages(decisions: Map<Pending, Decision>): void {
    // An opened package's files resolve through the loader's scope, so its consumers would reach that build.
    if (![...decisions.values()].some(d => d.action === 'scope' && d.partlyServed)) return;
    for (const [item, decision] of decisions)
      if (decision.action === 'share' && item.ctx.scopeType !== 'strict')
        decisions.set(item, { action: 'scope', partlyServed: false });
  }

  function decidePackage(remoteEntry: RemoteEntry, group: Pending[], served: Served): Decision {
    const pkg = packageOf(group[0]!.external.packageName);
    if (![...served.keys()].some(specifier => packageOf(specifier) === pkg))
      return { action: 'share' };

    const specifiers = group.flatMap(({ external }) => Object.keys(external.entries));
    const builds = specifiers.every(specifier => served.has(specifier))
      ? new Set(specifiers.map(specifier => served.get(specifier)!.copy.name))
      : undefined;

    const rejections = group.flatMap(item => rejectionsOf(item, served));
    if (rejections.length > 0) {
      const fromTwoBuilds = builds !== undefined && builds.size > 1;
      for (const rejection of refused(group, rejections, fromTwoBuilds, served))
        reportIncompatible(remoteEntry, rejection);
      return { action: 'scope', partlyServed: false };
    }

    if (!builds || builds.size > 1) return { action: 'scope', partlyServed: true };
    return { action: 'skip', files: servingFiles(served, pkg, builds) };
  }

  // What the map serves of the package from the build the remote follows; a named scope maps all of it, as init
  // maps a skip copy's serving version.
  function servingFiles(
    served: Served,
    pkg: string,
    builds: ReadonlySet<RemoteName>
  ): Map<Specifier, SharedVersionMeta> {
    const files = new Map<Specifier, SharedVersionMeta>();
    for (const [specifier, { copy }] of served)
      if (builds.has(copy.name) && packageOf(specifier) === pkg) files.set(specifier, copy);
    return files;
  }

  // A non-strict range follows the map's tag all the same, as at init.
  function rejectionsOf(item: Pending, served: Served): Rejection[] {
    const { external, ctx } = item;
    if (!ctx.remote.strictVersion) return [];
    return Object.keys(external.entries).flatMap(specifier => {
      const claim = served.get(specifier);
      return claim && !accepts(claim.tag, ctx.tag, ctx.remote.requiredVersion)
        ? [{ item, specifier, claim }]
        : [];
    });
  }

  // The first rejection of each copy that a cold init of the same remotes refuses too; see
  // docs/version-resolver.md §"Scope and dynamic init".
  function refused(
    group: Pending[],
    rejections: Rejection[],
    fromTwoBuilds: boolean,
    served: Served
  ): Rejection[] {
    const pkg = packageOf(group[0]!.external.packageName);
    const pooled = isPooledPackage(group, pkg);
    const claims = [...served].filter(([specifier]) => packageOf(specifier) === pkg);
    const copies = group.map(({ ctx }) => ({ tag: ctx.tag, copy: ctx.remote }));
    const splits = fromTwoBuilds || loadSplitsPackage(copies, claims, accepts);

    const first = new Map<Pending, Rejection>();
    for (const rejection of rejections)
      if (
        !first.has(rejection.item) &&
        (pooled || !splits || rejection.claim.external === rejection.item.external.packageName)
      )
        first.set(rejection.item, rejection);
    return [...first.values()];
  }

  // Pool membership is decided across every copy, so a label on any copy or a pool on the record counts.
  function isPooledPackage(group: Pending[], pkg: string): boolean {
    if (group.some(({ ctx }) => ctx.remote.pool?.trim())) return true;
    const record = ports.sharedExternalsRepo.getFromScope(group[0]!.external.shareScope);
    return isPooled(Object.entries(record).filter(([name]) => packageOf(name) === pkg));
  }

  function reportIncompatible(
    remoteEntry: RemoteEntry,
    { item: { external, ctx }, specifier, claim }: Rejection
  ) {
    const errorMsg = `[${external.shareScope ?? GLOBAL_SCOPE}][${remoteEntry.name}] ${specifier}@${
      ctx.tag
    } Is not compatible with existing ${specifier}@${claim.tag} requiredRange '${
      ctx.remote.requiredVersion
    }'`;

    if (config.strict.strictExternalCompatibility) {
      config.log.error(8, errorMsg);
      throw new NFError(`Could not process remote '${remoteEntry.name}'`);
    }
    config.log.warn(8, errorMsg);
  }

  function applyDecision(
    remoteEntry: RemoteEntry,
    { external, ctx }: Pending,
    decision: Decision
  ): LoadActions[string] {
    storeCopy(ctx, decision.action);
    if (decision.action !== 'skip') return { action: decision.action };

    const covered = Object.keys(external.entries);
    if (!external.shareScope) return { action: 'skip', covered };
    return {
      action: 'skip',
      covered,
      override: overrideFrom(remoteEntry, external, decision.files),
    };
  }

  // A skip copy keeps out of the share row, where it would claim on the next page what the map serves from the
  // build it follows. A scoped one stays inside a shareable version, where a later import-map build would
  // redirect it to the basis.
  function storeCopy(ctx: SharedExternalContext, action: SharedVersionAction): void {
    const { tag, remote, cached } = ctx;
    const shared = cached.versions.find(v => v.tag === tag && v.action === 'share');
    if (shared && action !== 'scope') ctx.assertSameVersionCompatibility(shared);

    remote.cached = action !== 'skip';
    const row =
      action === 'share' ? shared : cached.versions.find(v => v.tag === tag && v.action === action);
    if (!row) cached.versions.push({ tag, action, host: false, remotes: [remote] });
    else if (action === 'share') addRemoteToVersion(row, remote);
    else row.remotes.push(remote);
    // Only a package the map doesn't serve is shared, so the loader serves it; the strict scope serves every
    // version side by side.
    if (action === 'share' && ctx.scopeType !== 'strict') cached.servingBuild = remote.name;
    ctx.write();
  }

  // A named scope has no `imports` to inherit: each entrypoint maps to the file the committed map serves it from.
  function overrideFrom(
    remoteEntry: RemoteEntry,
    external: DenseSharedInfo,
    files: Map<Specifier, SharedVersionMeta>
  ): Record<string, string> {
    return Object.fromEntries(
      Array.from(files, ([specifier, copy]) => [
        specifier,
        _path.join(providerScopeUrl(remoteEntry, external, copy.name), copy.entries[specifier]!),
      ])
    );
  }

  function providerScopeUrl(
    remoteEntry: RemoteEntry,
    external: DenseSharedInfo,
    providerName: string
  ): string {
    return ports.remoteInfoRepo
      .tryGet(providerName)
      .map(remote => remote.scopeUrl)
      .orThrow(() => {
        config.log.error(
          8,
          `[${external.shareScope ?? GLOBAL_SCOPE}][${remoteEntry.name}][${
            external.packageName
          }@${external.version}][override] Remote name not found in cache.`
        );
        return new NFError(`Could not find override url from remote ${providerName}`);
      });
  }
}
