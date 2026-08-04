import type { ForPoolingDynamicExternals } from '../../driver-ports/init/for-pooling-dynamic-externals.port';
import type { ModeConfig } from '../../config/mode.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import {
  type ExternalName,
  GLOBAL_SCOPE,
  type RemoteName,
  STRICT_SCOPE,
  type SharedInfoActions,
} from 'lib/core/1.domain';
import { buildPools } from './pool-graph';
import {
  basisPerMember,
  committedView,
  consumedMembers,
  consumedSpecifiers,
  hostRemotes,
} from './pool-views';
import { lazy } from './pool.util';
import {
  acceptanceTable,
  acceptsAll,
  covers,
  explainSelfServe,
  isWitnessed,
  type Acceptance,
} from './anchoring';
import type { CommittedView, PoolMember, Specifier } from './pool.types';
import * as _path from 'lib/utils/path';

// One pool as both gates read it, for the remote being loaded.
type GateViews = {
  pool: PoolMember[];
  view: CommittedView;
  wants: ExternalName[];
  specifiers: Set<Specifier>;
  acceptance: () => Acceptance;
};

export function createPoolDynamicExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo' | 'remoteInfoRepo' | 'versionCheck'>
): ForPoolingDynamicExternals {
  /**
   * Dynamic-init counterpart of pool-shared-externals. The committed import map is immutable, so
   * this step is strictly additive: it only adjusts the newly loaded remote's own actions, never
   * the existing shared versions (host precedence was already applied when those were elected).
   * See docs/version-resolver.md.
   */
  return ({ entry, actions }) => {
    const { useAutoExternalPooling } = config.feature;

    // The poolable singletons this entry declares, per share scope — what it may have its actions rewritten
    // for. Membership is decided below, off the committed record rather than off this list.
    const declared = new Map<string, Set<ExternalName>>();
    for (const external of entry.shared ?? []) {
      const name = external.packageName;
      if (!external.singleton || !actions[name]) continue;
      if (external.shareScope === STRICT_SCOPE) continue;

      const shareScope = external.shareScope ?? GLOBAL_SCOPE;
      let names = declared.get(shareScope);
      if (!names) declared.set(shareScope, (names = new Set()));
      names.add(name);
    }
    if (declared.size === 0) return Promise.resolve({ entry, actions });

    const scope = (name: string) => {
      actions[name]!.action = 'scope';
      delete actions[name]!.override;
    };

    for (const [shareScope, names] of declared) {
      // With auto-pooling off, a tag anywhere in the committed scope forms pools this entry is subject to —
      // its own tag is not required. A tag is remote-local for *membership* only; the pool it forms then
      // operates on the whole external, this entry's copies included (see docs/version-resolver.md
      // §"Unscoped lockstep families"). Reading only this entry's tags is what let an untagged remote
      // bridge two builds the portfolio had deliberately pooled apart.
      if (!useAutoExternalPooling && !ports.sharedExternalsRepo.hasPoolTag(shareScope)) continue;

      const committed = ports.sharedExternalsRepo.getFromScope(shareScope);

      for (const pool of buildPools(committed, useAutoExternalPooling).values()) {
        // Only the members this entry declares have an action to rewrite; the rest of the pool is context —
        // its builds are candidates and its committed tags are what the gate reads.
        const mine = pool.filter(member => names.has(member.name));
        if (mine.length === 0) continue;

        // Island-or-defer: only a real incompatibility scopes the whole family (no dedup — a
        // same-version sibling would bridge the foreign build). A `share`+`skip` mix is a coverage
        // gap, not a conflict, so the gate below decides it on coverage.
        if (mine.some(member => actions[member.name]!.action === 'scope')) {
          mine.forEach(member => scope(member.name));
          continue;
        }

        const asked = gateViews(entry.name, pool);
        const anchor = anchorFor(entry.name, asked);
        if (anchor === 'witnessed') continue;

        if (anchor === undefined) {
          const reason = explainDynamic(entry.name, asked);
          const closest = reason.closest
            ? `closest is '${reason.closest}'`
            : 'no committed build serves any of it';
          config.log.warn(
            8,
            `[${shareScope}] '${entry.name}' serves its own family: no committed build offers every entrypoint it imports at a version it accepts — '${reason.gap}' is the gap, ${closest}. All ${mine.length} members it imports are scoped for it.`
          );
          mine.forEach(member => scope(member.name));
          continue;
        }

        redirect(entry.name, anchor, pool, asked.view, actions, shareScope);
      }
    }

    return Promise.resolve({ entry, actions });
  };

  // Everything both gates read about one pool, built once: `explainSelfServe` asks for the same projections
  // the witness and the coverage test do, and only the version table is expensive enough to defer.
  function gateViews(remote: RemoteName, pool: PoolMember[]): GateViews {
    return {
      pool,
      view: committedView(pool),
      wants: consumedMembers(pool).get(remote) ?? [],
      specifiers: consumedSpecifiers(pool).get(remote) ?? new Set<Specifier>(),
      acceptance: lazy(() => acceptanceTable(pool, ports.versionCheck.isCompatible)),
    };
  }

  /**
   * The init gate, asked of what the loaded remote would dedup onto: the witness first, then a committed
   * build that covers every entrypoint it imports at versions it accepts. Nothing here re-points an
   * existing remote — the only thing that can move is the remote being loaded.
   */
  function anchorFor(
    remote: RemoteName,
    { pool, view, wants, specifiers, acceptance }: GateViews
  ): RemoteName | 'witnessed' | undefined {
    const shared = new Map<Specifier, string>();
    for (const [specifier, source] of view.global) shared.set(specifier, source.tag);

    if (isWitnessed(specifiers, shared, view.builds)) return 'witnessed';

    const basis = basisPerMember(pool);

    for (const build of candidateOrder(pool, view)) {
      if (build === remote) continue;
      const candidate = view.builds.get(build)!;
      if (!servesItsOwnFamily(build, pool, basis)) continue;
      if (!covers(candidate.coverage, specifiers)) continue;
      if (!acceptsAll(acceptance(), candidate.instance, remote, wants)) continue;
      return build;
    }

    return undefined;
  }

  /**
   * Cheapest candidate first: a build the committed map already serves this pool from costs nothing at all
   * (`redirect` writes no override for a specifier already served from it), then the host, whose build the
   * browser has loaded regardless. Name breaks the rest, so the choice stays reload-stable.
   */
  function candidateOrder(pool: PoolMember[], view: CommittedView): RemoteName[] {
    const serving = new Set<RemoteName>();
    for (const source of view.global.values()) serving.add(source.remote);
    const hosts = hostRemotes(pool);

    const rank = (build: RemoteName) => (serving.has(build) ? 0 : hosts.has(build) ? 1 : 2);

    return [...view.builds.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  /**
   * Constraint 9, read off the committed record: a candidate qualifies only if it wins every member it
   * ships (the map already names its own files for its whole family) or every copy it holds is scoped (an
   * island, running its own build by construction). Anything in between resolved part of its family through
   * the global winner, so its modules are already bound and a consumer deduping onto it inherits that —
   * which no additive map can repair.
   */
  function servesItsOwnFamily(
    build: RemoteName,
    pool: PoolMember[],
    basis: Map<ExternalName, RemoteName>
  ): boolean {
    let ships = 0;
    let winsAll = true;
    let allScoped = true;

    for (const member of pool) {
      for (const version of member.external.versions) {
        const meta = version.remotes.find(r => r.name === build);
        if (!meta) continue;
        if (meta.servedBy !== undefined) return false;
        ships++;
        if (version.action !== 'scope') allScoped = false;
        if (basis.get(member.name) !== build) winsAll = false;
      }
    }

    return ships > 0 && (winsAll || allScoped);
  }

  function explainDynamic(remote: RemoteName, { view, wants, specifiers, acceptance }: GateViews) {
    return explainSelfServe(remote, wants, specifiers, {
      builds: view.builds,
      acceptance: acceptance(),
    });
  }

  /**
   * Point the loaded remote at the anchor's files, through the per-consumer override
   * `convert-to-import-map` emits for a skip. Only specifiers the committed map does not already serve from
   * the anchor get an entry, so deduping onto the current global provider adds nothing to the delta.
   *
   * `covered` is set for every member either way: it is per external, so a specifier the anchor serves as an
   * entry of a *different* member would otherwise be self-filled from the loaded remote's own build — one
   * file from a second build, which is the whole thing being prevented.
   */
  function redirect(
    remote: RemoteName,
    anchor: RemoteName,
    pool: PoolMember[],
    view: CommittedView,
    actions: SharedInfoActions,
    shareScope: string
  ): void {
    const files = view.builds.get(anchor)!.coverage;
    const scopeUrl = ports.remoteInfoRepo.tryGet(anchor).get()?.scopeUrl;
    if (!scopeUrl) {
      config.log.warn(
        8,
        `[${shareScope}][${remote}] '${anchor}' is not in the cache, so its files cannot be mapped.`
      );
      return;
    }

    for (const member of pool) {
      const action = actions[member.name];
      if (!action || action.action !== 'skip') continue;

      const own = member.external.versions.flatMap(v => v.remotes).find(r => r.name === remote);
      if (!own) continue;

      const specifiers = Object.keys(own.entries);
      if (specifiers.length === 0) continue;

      const override: Record<string, string> = {};
      for (const specifier of specifiers) {
        if (view.global.get(specifier)?.remote === anchor) continue;
        const file = files.get(specifier);
        if (file) override[specifier] = _path.join(scopeUrl, file);
      }

      action.covered = specifiers;
      if (Object.keys(override).length > 0) action.override = override;
    }
  }
}
