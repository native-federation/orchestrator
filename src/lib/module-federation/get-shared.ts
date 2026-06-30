import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
import type { GetSharedOptions, ShareConfig } from './share-config.contract';

/**
 * Adapts native federation's shared externals to webpack Module Federation.
 *
 * Converts the orchestrator's globally shared externals into the `ShareConfig`
 * shape webpack MF expects, so an app using both federation systems can hand
 * native federation's singletons straight to MF (e.g. `init({ shared })`):
 *
 * ```ts
 * import { createGetShared } from '@softarc/native-federation-orchestrator/module-federation';
 *
 * const result = await initFederation(...);
 * const getShared = createGetShared(result.adapters);
 * init({ name: 'host', shared: getShared() });
 * ```
 *
 * The v3 runtime read its singletons from a flat `externals` Map; v4 stores them
 * in the `shared-externals` repository while the resolved URLs live in the
 * generated import map. This reads both: the version/range metadata from the
 * repository and each URL from the (already resolved) import map, so it never
 * re-implements the resolver's scope/skip/override logic.
 */
export function createGetShared(
  ports: Pick<DrivingContract, 'sharedExternalsRepo' | 'importMapRepo' | 'browser'>
): (options?: GetSharedOptions) => ShareConfig {
  return (options = {}) => {
    const shared: ShareConfig = {};
    const { imports } = ports.importMapRepo.get();
    const globalExternals = ports.sharedExternalsRepo.getFromScope();

    for (const [packageName, external] of Object.entries(globalExternals)) {
      const version = external.versions.find(v => v.action === 'share');
      if (!version) continue;

      const url = imports[packageName];
      if (!url) continue;

      const requiredVersion =
        typeof options.requiredVersionPrefix === 'string'
          ? `${options.requiredVersionPrefix}${version.tag}`
          : (version.remotes[0]?.requiredVersion ?? `^${version.tag}`);

      shared[packageName] = [
        {
          version: version.tag,
          get: () => ports.browser.importModule(url).then(module => () => module),
          shareConfig: {
            singleton: options.singleton ?? true,
            requiredVersion,
          },
        },
      ];
    }

    return shared;
  };
}
