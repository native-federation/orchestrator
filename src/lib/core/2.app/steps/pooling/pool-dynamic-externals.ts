import type { ForPoolingDynamicExternals } from '../../driver-ports/init/for-pooling-dynamic-externals.port';
import type { ModeConfig } from '../../config/mode.contract';
import { resolvePoolMembership } from './pool-membership';
import type { PoolName } from './pool.types';

export function createPoolDynamicExternals(config: ModeConfig): ForPoolingDynamicExternals {
  /**
   * Dynamic-init counterpart of pool-shared-externals. The import map for existing remotes is
   * already committed and immutable, so this step is strictly **additive**: it only adjusts the
   * *newly loaded* remote's own actions, never the existing shared versions.
   *
   * Per pool in the new entry: if any member would be `scope` (incompatible with the existing
   * anchor), or a member would introduce a new global `share` while another member already
   * follows an existing anchor (`skip`), the remote cannot stay coherent by mixing sources —
   * force its *entire* pool family to `scope` (served from its own build) and drop any override.
   * All members compatibly `skip`, or the remote introducing the whole pool itself (all `share`),
   * are left untouched.
   */
  return ({ entry, actions }) => {
    const { useAutoExternalPooling } = config.profile;

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

    for (const members of pools.values()) {
      const memberActions = members.map(name => actions[name]!.action);
      const forceScope =
        memberActions.includes('scope') ||
        (memberActions.includes('share') && memberActions.includes('skip'));

      if (!forceScope) continue;

      for (const name of members) {
        actions[name]!.action = 'scope';
        delete actions[name]!.override;
      }
    }

    return Promise.resolve({ entry, actions });
  };
}
