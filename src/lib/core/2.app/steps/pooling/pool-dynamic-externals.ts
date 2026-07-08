import type { ForPoolingDynamicExternals } from '../../driver-ports/init/for-pooling-dynamic-externals.port';
import type { ModeConfig } from '../../config/mode.contract';
import { resolvePoolMembership } from './pool-membership';
import type { PoolName } from './pool.types';

export function createPoolDynamicExternals(config: ModeConfig): ForPoolingDynamicExternals {
  /**
   * Dynamic-init counterpart of pool-shared-externals. The import map for existing remotes is
   * already committed and immutable, so this step is strictly **additive**: it only adjusts the
   * *newly loaded* remote's own actions, never the existing shared versions. Host precedence is
   * honored by construction — the committed shared versions a `skip` follows were already elected
   * with host-first precedence in the init step; this step never re-elects.
   *
   * Per pool in the new entry, mirroring the anchor model's reason-carrying classification:
   *  - **incompatibility-forced** (any member is `scope` — strict-incompatible with the committed
   *    build): scope the *entire* family with **no** dedup. Deduping a same-version sibling here is
   *    exactly what would inject a foreign build via a shared intermediary.
   *  - **coverage-forced** (members mix `share` and `skip`, none `scope`): a `share` member would
   *    introduce a new global shared version, impossible on an immutable committed map — so it scopes
   *    its own copy. `skip` members are same-version as the committed build and **dedup** (stay
   *    `skip`, fall through to the shared build — no extra download).
   *  - all `skip` (fully compatible) or all `share` (this remote introduces the whole pool): untouched.
   */
  return ({ entry, actions }) => {
    const { useAutoExternalPooling } = config.profile;

    // has-pool early-out: with auto-pooling off, only an explicit `pool` tag on this entry can
    // form a pool. A short-circuiting probe over the new entry's own shared list (the only input
    // this additive step reads) skips the work below when nothing here is poolable.
    if (!useAutoExternalPooling && !(entry.shared ?? []).some(e => e.pool?.trim())) {
      return Promise.resolve({ entry, actions });
    }

    const pools = new Map<PoolName, string[]>();
    for (const external of entry.shared ?? []) {
      if (!external.singleton || !actions[external.packageName]) continue;

      const poolName = resolvePoolMembership(
        external.packageName,
        external.pool ? [external.pool] : [],
        useAutoExternalPooling
      );
      if (!poolName) continue;

      pools.set(poolName, [...(pools.get(poolName) ?? []), external.packageName]);
    }

    const scope = (name: string) => {
      actions[name]!.action = 'scope';
      delete actions[name]!.override;
    };

    for (const members of pools.values()) {
      const memberActions = members.map(name => actions[name]!.action);

      if (memberActions.includes('scope')) {
        // Incompatibility-forced: whole family scopes, no dedup.
        members.forEach(scope);
      } else if (memberActions.includes('share') && memberActions.includes('skip')) {
        // Coverage-forced: only the new-share (orphan) members scope; same-version `skip` members
        // dedup and fall through to the committed shared build.
        members.filter(name => actions[name]!.action === 'share').forEach(scope);
      }
    }

    return Promise.resolve({ entry, actions });
  };
}
