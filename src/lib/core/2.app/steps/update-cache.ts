import type { ForUpdatingCache } from '../driver-ports/init/for-updating-cache';
import {
  type RemoteEntry,
  type DenseSharedInfo,
  type ExternalName,
  type RemoteName,
  type SharedVersionAction,
  type SharedVersionMeta,
  GLOBAL_SCOPE,
} from 'lib/core/1.domain';
import type { LoadActions } from 'lib/core/1.domain/remote-entry/load-actions.contract';
import { createAcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { addRemoteToVersion } from 'lib/core/1.domain/externals/basis';
import { loadSplitsPackage } from 'lib/core/1.domain/externals/serving';
import { type Claim, committedClaims } from 'lib/core/1.domain/externals/claims';
import {
  groupByPackage,
  type PackageOf,
  packageOfIn,
  type Specifier,
} from 'lib/core/1.domain/externals/specifier';
import { type LabelledCopy, pooledPackagesWith } from 'lib/core/1.domain/pooling/membership';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import * as _path from 'lib/utils/path';
import { NFError } from 'lib/core/native-federation.error';
import type { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { createStoreRemoteEntry, type SharedExternalContext } from './store-remote-entry';

type Pending = { external: DenseSharedInfo; ctx: SharedExternalContext };

type CommittedClaims = Map<Specifier, Claim>;

type PackageClaims = readonly [Specifier, Claim][];

// Indexes the record as decidePackages reads it, so it must not outlive it: applyDecision writes that record.
type LoadView = {
  packageOf: PackageOf;
  claims: CommittedClaims;
  claimsOf(pkg: ExternalName): PackageClaims;
  inPool(pkg: ExternalName): boolean;
};

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
    const viewOf = loadViewOf(remoteEntry, pending);
    for (const group of pendingPerPackage(pending, viewOf)) {
      // The strict scope shares every version side by side.
      const decision =
        group[0]!.ctx.scopeType === 'strict'
          ? ({ action: 'share' } as const)
          : decidePackage(remoteEntry, group, viewOf(group[0]!.external.shareScope));
      for (const item of group) decisions.set(item, decision);
    }
    scopeOpenedPackages(decisions);
    return decisions;
  }

  function pendingPerPackage(
    pending: Pending[],
    viewOf: (shareScope: string | undefined) => LoadView
  ): Pending[][] {
    const packages = new Map<string, Pending[]>();
    for (const item of pending) {
      const { shareScope, packageName } = item.external;
      // The strict scope shares each external whatever its package, so it needs no view.
      const pkg =
        item.ctx.scopeType === 'strict' ? packageName : viewOf(shareScope).packageOf(packageName);
      const key = `${shareScope ?? GLOBAL_SCOPE}\0${pkg}`;
      const group = packages.get(key);
      if (group) group.push(item);
      else packages.set(key, [item]);
    }
    return [...packages.values()];
  }

  function loadViewOf(
    remoteEntry: RemoteEntry,
    pending: Pending[]
  ): (shareScope: string | undefined) => LoadView {
    const views = new Map<string, LoadView>();
    return shareScope => {
      const scope = shareScope ?? GLOBAL_SCOPE;
      let view = views.get(scope);
      if (!view) {
        const record = ports.sharedExternalsRepo.getFromScope(shareScope);
        const claims = committedClaims(Object.entries(record), {
          shareScope: scope,
          without: remoteEntry.name,
        });
        // The load's copies count as stored: they can only merge packages the committed map serves apart.
        const packageOf = packageOfIn(record, loadingIn(pending, scope));
        const claimsIn = groupByPackage(claims, ([specifier]) => specifier, packageOf);
        let pooled: Set<ExternalName> | undefined;
        view = {
          packageOf,
          claims,
          claimsOf: pkg => claimsIn.get(pkg) ?? [],
          inPool: pkg => {
            pooled ??= pooledPackagesWith(record, labelledCopiesIn(pending, scope), packageOf);
            return pooled.has(pkg);
          },
        };
        views.set(scope, view);
      }
      return view;
    };
  }

  function inScope(pending: Pending[], scope: string): Pending[] {
    return pending.filter(({ external }) => (external.shareScope ?? GLOBAL_SCOPE) === scope);
  }

  function loadingIn(pending: Pending[], scope: string): [ExternalName, SharedVersionMeta][] {
    return inScope(pending, scope).map(({ external, ctx }) => [external.packageName, ctx.remote]);
  }

  // The load's copies count as stored, so a pool only their labels form is judged as the gate will see it.
  function labelledCopiesIn(pending: Pending[], scope: string): LabelledCopy[] {
    return inScope(pending, scope).map(({ external, ctx }) => ({
      name: external.packageName,
      pool: ctx.remote.pool,
    }));
  }

  function scopeOpenedPackages(decisions: Map<Pending, Decision>): void {
    // An opened package's files resolve through the loader's scope, so its consumers would reach that build.
    if (![...decisions.values()].some(d => d.action === 'scope' && d.partlyServed)) return;
    for (const [item, decision] of decisions)
      if (decision.action === 'share' && item.ctx.scopeType !== 'strict')
        decisions.set(item, { action: 'scope', partlyServed: false });
  }

  function decidePackage(remoteEntry: RemoteEntry, group: Pending[], view: LoadView): Decision {
    const pkg = view.packageOf(group[0]!.external.packageName);
    const claims = view.claimsOf(pkg);
    if (claims.length === 0) return { action: 'share' };

    const specifiers = group.flatMap(({ external }) => Object.keys(external.entries));
    const builds = specifiers.every(specifier => view.claims.has(specifier))
      ? new Set(specifiers.map(specifier => view.claims.get(specifier)!.copy.name))
      : undefined;

    const rejections = group.flatMap(item => rejectionsOf(item, view.claims));
    if (rejections.length > 0) {
      const copies = group.map(({ ctx }) => ({ tag: ctx.tag, copy: ctx.remote }));
      const splits =
        (builds !== undefined && builds.size > 1) ||
        loadSplitsPackage(pkg, copies, claims, accepts);
      for (const rejection of refused(rejections, splits, view.inPool(pkg)))
        reportIncompatible(remoteEntry, rejection);
      return { action: 'scope', partlyServed: false };
    }

    if (!builds || builds.size > 1) return { action: 'scope', partlyServed: true };
    return { action: 'skip', files: servingFiles(claims, builds) };
  }

  // What the map serves of the package from the build the remote follows; a named scope maps all of it, as init
  // maps a skip copy's serving version.
  function servingFiles(
    claims: PackageClaims,
    builds: ReadonlySet<RemoteName>
  ): Map<Specifier, SharedVersionMeta> {
    const files = new Map<Specifier, SharedVersionMeta>();
    for (const [specifier, { copy }] of claims)
      if (builds.has(copy.name)) files.set(specifier, copy);
    return files;
  }

  // A non-strict range follows the map's tag all the same, as at init.
  function rejectionsOf(item: Pending, claims: CommittedClaims): Rejection[] {
    const { external, ctx } = item;
    if (!ctx.remote.strictVersion) return [];
    return Object.keys(external.entries).flatMap(specifier => {
      const claim = claims.get(specifier);
      return claim && !accepts(claim.tag, ctx.tag, ctx.remote.requiredVersion)
        ? [{ item, specifier, claim }]
        : [];
    });
  }

  // The first rejection of each copy that a cold init keeping the committed builds refuses too; see
  // docs/version-resolver.md §"Scope and dynamic init".
  function refused(rejections: Rejection[], splits: boolean, pooled: boolean): Rejection[] {
    const first = new Map<Pending, Rejection>();
    for (const rejection of rejections)
      if (!first.has(rejection.item) && (pooled || !splits || electionKeeps(rejection)))
        first.set(rejection.item, rejection);
    return [...first.values()];
  }

  // A cold election with the loader refuses the claimed tag where no tag pleases every strict copy, and otherwise
  // keeps it only on a host row, or the newest with latestSharedExternal.
  function electionKeeps({ item: { external, ctx }, claim }: Rejection): boolean {
    if (claim.external !== external.packageName) return false;
    const versions =
      ports.sharedExternalsRepo.tryGet(claim.external, external.shareScope).get()?.versions ?? [];
    const strict = [
      { tag: ctx.tag, copy: ctx.remote },
      ...versions.flatMap(v =>
        v.remotes.filter(r => r.strictVersion).map(copy => ({ tag: v.tag, copy }))
      ),
    ];
    const tags = [ctx.tag, ...versions.map(v => v.tag)];
    if (!tags.some(tag => strict.every(s => accepts(tag, s.tag, s.copy.requiredVersion))))
      return true;
    const host = versions.find(v => v.host);
    if (host) return host.tag === claim.tag;
    if (!config.profile.latestSharedExternal) return false;
    return tags.every(tag => ports.versionCheck.compare(claim.tag, tag) >= 0);
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
    const { tag, remote } = ctx;
    const cached = ctx.readRecord();
    const shared = cached.versions.find(v => v.tag === tag && v.action === 'share');
    if (shared && action !== 'scope') ctx.assertSameVersionCompatibility(shared);

    remote.cached = action !== 'skip';
    const row =
      action === 'share' ? shared : cached.versions.find(v => v.tag === tag && v.action === action);
    // Only a package the map doesn't serve is shared, so the loader serves it. The strict scope serves every version
    // side by side: a strict row keeps the basis the committed map and getShared serve it from.
    const loaderServes = action === 'share' && ctx.scopeType !== 'strict';
    if (!row) cached.versions.push({ tag, action, host: false, remotes: [remote] });
    else if (loaderServes) addRemoteToVersion(row, remote);
    else row.remotes.push(remote);
    if (loaderServes) cached.servingBuild = remote.name;
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
