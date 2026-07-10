import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
import type { SharedVersion } from 'lib/core/1.domain';
import type { GetSharedOptions, ShareInfos, Shared } from './share-infos.contract';
import * as _path from 'lib/utils/path';

/**
 * Adapts native federation's shared externals to the `ShareInfos` shape webpack
 * Module Federation expects (see `docs/module-federation.md`).
 */
export function createGetShared(
  ports: Pick<DrivingContract, 'sharedExternalsRepo' | 'remoteInfoRepo' | 'browser'>
): (options?: GetSharedOptions) => ShareInfos {
  return (options = {}) => {
    const shared: ShareInfos = {};

    for (const scope of ports.sharedExternalsRepo.getScopes({ includeGlobal: true })) {
      const scopeType = ports.sharedExternalsRepo.scopeType(scope);
      const externals = ports.sharedExternalsRepo.getFromScope(scope);

      for (const external of Object.values(externals)) {
        const shareVersions = external.versions.filter(v => v.action === 'share');
        if (shareVersions.length === 0) continue;

        // The strict scope is a version -> location map: every version is shared
        // side by side and stays non-singleton. Other scopes share one singleton.
        const versions = scopeType === 'strict' ? shareVersions : shareVersions.slice(0, 1);
        const singleton = scopeType === 'strict' ? false : (options.singleton ?? true);

        for (const version of versions) {
          const source = version.remotes[0];
          if (!source) continue;

          // MF's shared config is flat: one key per entrypoint. Emit a separate
          // Shared for each entry so secondary entrypoints reach MF consumers.
          for (const [entryName, file] of Object.entries(source.entries)) {
            const url = resolveUrl(version, file);
            if (!url) continue;

            const shareObject: Shared = {
              version: version.tag,
              get: () => ports.browser.importModule(url).then(module => () => module),
              shareConfig: {
                singleton,
                requiredVersion: resolveRequiredVersion(version, options, scopeType),
                ...(scopeType === 'strict' ? { strictVersion: true } : {}),
              },
            };
            if (scopeType !== 'global') shareObject.scope = scope;

            if (!shared[entryName]) shared[entryName] = [];
            shared[entryName]!.push(shareObject);
          }
        }
      }
    }

    return shared;
  };

  function resolveUrl(version: SharedVersion, file: string): string | undefined {
    const source = version.remotes[0];
    if (!source) return undefined;

    return ports.remoteInfoRepo
      .tryGet(source.name)
      .map(remote => _path.join(remote.scopeUrl, file))
      .get();
  }
}

function resolveRequiredVersion(
  version: SharedVersion,
  options: GetSharedOptions,
  scopeType: 'global' | 'strict' | 'shareScope'
): string {
  // Strict shares a specific version, not a range: pin to the exact tag so a
  // consumer reuses only that version (MF matches via satisfy(version, required)).
  if (scopeType === 'strict') return version.tag;
  if (typeof options.requiredVersionPrefix === 'string') {
    return `${options.requiredVersionPrefix}${version.tag}`;
  }
  return version.remotes[0]?.requiredVersion || `^${version.tag}`;
}
