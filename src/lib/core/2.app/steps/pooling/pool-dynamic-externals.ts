import type { ForPoolingDynamicExternals } from '../../driver-ports/init/for-pooling-dynamic-externals.port';
import type { ModeConfig } from '../../config/mode.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import { type ExternalName, GLOBAL_SCOPE, STRICT_SCOPE } from 'lib/core/1.domain';
import { autoScope, groupByMembership, type PoolCandidate } from './pool-graph';
import { buildInstances, findDisagreement, servingBuilds } from './family-instance';
import type { PoolMember } from './pool.types';

export function createPoolDynamicExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo'>
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
      for (const members of groupByMembership(candidates).values()) {
        const memberActions = members.map(name => actions[name]!.action);

        // Island-or-defer: only a real incompatibility scopes the whole family (no dedup — a
        // same-version sibling would bridge the foreign build). A `share`+`skip` mix is a coverage
        // gap, not a conflict, so the loaded remote keeps the resolver's verdict.
        if (memberActions.includes('scope')) {
          members.forEach(scope);
          continue;
        }

        const clash = disagreementAcrossCommittedBuilds(members, shareScope);
        if (!clash) continue;

        config.log.warn(
          8,
          `[${shareScope}][${entry.name}] the committed builds serving this family disagree on '${clash.member}' (${clash.tag} vs ${clash.other}), so all ${members.length} pooled members are scoped for it.`
        );
        members.forEach(scope);
      }
    }

    return Promise.resolve({ entry, actions });
  };

  /**
   * The agreement gate of the init path, applied to what the loaded remote would dedup onto. Every
   * member here is `skip`, so the remote draws on the committed build serving each one; those builds
   * have to agree, i.e. place every member two of them both ship on the same minor line. Nothing is
   * re-pointed — the only thing that can move is the loaded remote, which scopes its whole family.
   *
   * Init already guarantees no *remote* draws disagreeing builds, but the committed shared set can
   * still hold two that disagree when no remote so far consumed both. That is the production
   * capture's shape (`@angular/forms@22.0.8` beside `@angular/forms/signals@21.2.18`), and a remote
   * loaded later is exactly the consumer that would bridge them.
   */
  function disagreementAcrossCommittedBuilds(names: ExternalName[], shareScope: string) {
    const committed = ports.sharedExternalsRepo.getFromScope(shareScope);
    const members: PoolMember[] = [];
    for (const name of names) {
      const external = committed[name];
      if (external) members.push({ name, external });
    }
    if (members.length < 2) return undefined;

    const instances = buildInstances(members);
    const serving = servingBuilds(members, { has: () => false });
    return findDisagreement(instances, [...new Set(serving.values())]);
  }
}
