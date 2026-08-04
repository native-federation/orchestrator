import type { ForPoolingDynamicExternals } from '../../driver-ports/init/for-pooling-dynamic-externals.port';
import type { ModeConfig } from '../../config/mode.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import {
  type ExternalName,
  GLOBAL_SCOPE,
  type RemoteName,
  STRICT_SCOPE,
  type SharedExternal,
  type SharedInfoActions,
} from 'lib/core/1.domain';
import { autoScope, groupByMembership, type PoolCandidate } from './pool-graph';
import { basisPerMember, committedView, consumedMembers, consumedSpecifiers } from './pool-views';
import { acceptanceTable, acceptsAll, covers, explainSelfServe, isWitnessed } from './anchoring';
import type { CommittedView, PoolMember, Specifier } from './pool.types';
import * as _path from 'lib/utils/path';

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

    // With auto-pooling off, only an explicit `pool` tag on this entry can form a pool.
    if (!useAutoExternalPooling && !(entry.shared ?? []).some(e => e.pool?.trim())) {
      return Promise.resolve({ entry, actions });
    }

    const byScope = new Map<string, PoolCandidate<string>[]>();
    for (const external of entry.shared ?? []) {
      const name = external.packageName;
      if (!external.singleton || !actions[name]) continue;
      if (external.shareScope === STRICT_SCOPE) continue;

      const tag = external.pool?.trim();
      const shareScope = external.shareScope ?? GLOBAL_SCOPE;
      const candidates = byScope.get(shareScope) ?? [];
      candidates.push({
        name,
        scope: autoScope(name, useAutoExternalPooling),
        tags: tag ? [{ remote: entry.name, tag }] : [],
        remotes: [entry.name],
        value: name,
      });
      byScope.set(shareScope, candidates);
    }

    const scope = (name: string) => {
      actions[name]!.action = 'scope';
      delete actions[name]!.override;
    };

    for (const [shareScope, candidates] of byScope) {
      const committed = ports.sharedExternalsRepo.getFromScope(shareScope);

      for (const members of groupByMembership(candidates).values()) {
        const memberActions = members.map(name => actions[name]!.action);

        // Island-or-defer: only a real incompatibility scopes the whole family (no dedup — a
        // same-version sibling would bridge the foreign build). A `share`+`skip` mix is a coverage
        // gap, not a conflict, so the gate below decides it on coverage.
        if (memberActions.includes('scope')) {
          members.forEach(scope);
          continue;
        }

        const pool = poolMembers(members, committed);
        if (pool.length < 2) continue;

        const view = committedView(pool);
        const anchor = anchorFor(entry.name, pool, view);
        if (anchor === 'witnessed') continue;

        if (anchor === undefined) {
          const reason = explainDynamic(entry.name, pool, view);
          const closest = reason.closest
            ? `closest is '${reason.closest}'`
            : 'no committed build serves any of it';
          config.log.warn(
            8,
            `[${shareScope}] '${entry.name}' serves its own family: no committed build offers every entrypoint it imports at a version it accepts — '${reason.gap}' is the gap, ${closest}. All ${members.length} members it imports are scoped for it.`
          );
          members.forEach(scope);
          continue;
        }

        redirect(entry.name, anchor, pool, view, actions, shareScope);
      }
    }

    return Promise.resolve({ entry, actions });
  };

  // The pool as the committed record holds it, the loaded remote's own copies included — `update-cache`
  // stored them before this step ran, which is what lets the same primitives decide both paths.
  function poolMembers(names: ExternalName[], committed: Record<string, SharedExternal>) {
    const members: PoolMember[] = [];
    for (const name of names) {
      const external = committed[name];
      if (external) members.push({ name, external });
    }
    return members;
  }

  /**
   * The init gate, asked of what the loaded remote would dedup onto: the witness first, then a committed
   * build that covers every entrypoint it imports at versions it accepts. Nothing here re-points an
   * existing remote — the only thing that can move is the remote being loaded.
   */
  function anchorFor(
    remote: RemoteName,
    pool: PoolMember[],
    view: CommittedView
  ): RemoteName | 'witnessed' | undefined {
    const specifiers = consumedSpecifiers(pool).get(remote) ?? new Set<Specifier>();
    const shared = new Map<Specifier, string>();
    for (const [specifier, source] of view.global) shared.set(specifier, source.tag);

    if (isWitnessed(specifiers, shared, view.builds)) return 'witnessed';

    const acceptance = acceptanceTable(pool, ports.versionCheck.isCompatible);
    const wants = consumedMembers(pool).get(remote) ?? [];
    const basis = basisPerMember(pool);

    for (const build of [...view.builds.keys()].sort()) {
      if (build === remote) continue;
      const candidate = view.builds.get(build)!;
      if (!servesItsOwnFamily(build, pool, basis)) continue;
      if (!covers(candidate.coverage, specifiers)) continue;
      if (!acceptsAll(acceptance, candidate.instance, remote, wants)) continue;
      return build;
    }

    return undefined;
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

  function explainDynamic(remote: RemoteName, pool: PoolMember[], view: CommittedView) {
    return explainSelfServe(
      remote,
      consumedMembers(pool).get(remote) ?? [],
      consumedSpecifiers(pool).get(remote) ?? new Set(),
      { builds: view.builds, acceptance: acceptanceTable(pool, ports.versionCheck.isCompatible) }
    );
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
