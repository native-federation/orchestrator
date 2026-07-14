import type { ForPoolingDynamicExternals } from '../../driver-ports/init/for-pooling-dynamic-externals.port';
import type { ModeConfig } from '../../config/mode.contract';
import { GLOBAL_SCOPE, STRICT_SCOPE } from 'lib/core/1.domain';
import { autoScope, groupByMembership, type PoolCandidate } from './pool-graph';

export function createPoolDynamicExternals(config: ModeConfig): ForPoolingDynamicExternals {
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
        value: name,
      });
      byScope.set(shareScope, candidates);
    }

    const scope = (name: string) => {
      actions[name]!.action = 'scope';
      delete actions[name]!.override;
    };

    for (const candidates of byScope.values()) {
      for (const members of groupByMembership(candidates).values()) {
        const memberActions = members.map(name => actions[name]!.action);

        // Island-or-defer: only a real incompatibility scopes the whole family (no dedup — a
        // same-version sibling would bridge the foreign build). A `share`+`skip` mix is a coverage
        // gap, not a conflict, so the loaded remote keeps the resolver's verdict.
        if (memberActions.includes('scope')) {
          members.forEach(scope);
        }
      }
    }

    return Promise.resolve({ entry, actions });
  };
}
