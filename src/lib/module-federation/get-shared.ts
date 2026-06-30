import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
import type { ImportMap, SharedVersion } from 'lib/core/1.domain';
import type { GetSharedOptions, ShareInfos, Shared } from './share-infos.contract';

/**
 * Adapts native federation's shared externals to webpack Module Federation.
 *
 * Converts the orchestrator's shared externals into the `ShareInfos` shape
 * webpack MF expects, so an app using both federation systems can hand native
 * federation's singletons straight to MF (e.g. `init({ shared })`):
 *
 * ```ts
 * import { createGetShared } from '@softarc/native-federation-orchestrator/module-federation';
 *
 * const result = await initFederation(...);
 * const getShared = createGetShared(result.adapters);
 * init({ name: 'host', shared: getShared() });
 * ```
 *
 * Every share scope is bridged: the global scope maps to MF's default scope,
 * while custom `shareScope` groups (and the `strict` scope) map to MF's `scope`
 * property. Only versions native federation resolved as `action: 'share'` are
 * emitted. The v3 runtime read its singletons from a flat `externals` Map; v4
 * stores the version/range metadata in the `shared-externals` repository while
 * the resolved URLs live in the generated import map. This reads both, so it
 * never re-implements the resolver's scope/skip/override logic.
 */
export function createGetShared(
  ports: Pick<
    DrivingContract,
    'sharedExternalsRepo' | 'remoteInfoRepo' | 'importMapRepo' | 'browser'
  >
): (options?: GetSharedOptions) => ShareInfos {
  return (options = {}) => {
    const shared: ShareInfos = {};
    const importMap = ports.importMapRepo.get();

    for (const scope of ports.sharedExternalsRepo.getScopes({ includeGlobal: true })) {
      const scopeType = ports.sharedExternalsRepo.scopeType(scope);
      const externals = ports.sharedExternalsRepo.getFromScope(scope);

      for (const [packageName, external] of Object.entries(externals)) {
        const shareVersions = external.versions.filter(v => v.action === 'share');
        if (shareVersions.length === 0) continue;

        const singleton = options.singleton ?? shareVersions.length === 1;

        for (const version of shareVersions) {
          const url =
            scopeType === 'global'
              ? importMap.imports[packageName]
              : resolveScopedUrl(importMap, version, packageName);
          if (!url) continue;

          const shareObject: Shared = {
            version: version.tag,
            get: () => ports.browser.importModule(url).then(module => () => module),
            shareConfig: {
              singleton,
              requiredVersion: resolveRequiredVersion(version, options),
              ...(scopeType === 'strict' ? { strictVersion: true } : {}),
            },
          };
          if (scopeType !== 'global') shareObject.scope = scope;

          if (!shared[packageName]) shared[packageName] = [];
          shared[packageName]!.push(shareObject);
        }
      }
    }

    return shared;
  };

  /**
   * A scoped external's resolved URL lives in the import map's `scopes` (keyed by
   * the providing remote's scope URL), not in the flat `imports`. The share
   * version's first remote is the canonical source for that scope.
   */
  function resolveScopedUrl(
    importMap: ImportMap,
    version: SharedVersion,
    packageName: string
  ): string | undefined {
    const source = version.remotes[0];
    if (!source) return undefined;

    return ports.remoteInfoRepo
      .tryGet(source.name)
      .map(remote => importMap.scopes?.[remote.scopeUrl]?.[packageName])
      .get();
  }
}

function resolveRequiredVersion(version: SharedVersion, options: GetSharedOptions): string {
  if (typeof options.requiredVersionPrefix === 'string') {
    return `${options.requiredVersionPrefix}${version.tag}`;
  }
  return version.remotes[0]?.requiredVersion ?? `^${version.tag}`;
}
