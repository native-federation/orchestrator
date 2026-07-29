import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
import type { SharedVersion, SharedVersionMeta } from 'lib/core/1.domain';
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
          if (!version.remotes[0]) continue;

          const requiredVersion = resolveRequiredVersion(version, options, scopeType);

          // MF's shared config is flat: one key per entrypoint. Emit a separate
          // Shared for each entry so secondary entrypoints reach MF consumers.
          const claimed = new Set<string>();
          for (const source of version.remotes) {
            for (const [entryName, file] of Object.entries(source.entries)) {
              if (claimed.has(entryName)) continue;
              claimed.add(entryName);

              const url = resolveUrl(source, file);
              if (!url) continue;

              const shareObject: Shared = {
                version: version.tag,
                get: () => ports.browser.importModule(url).then(module => () => module),
                shareConfig: {
                  singleton,
                  requiredVersion,
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
    }

    return shared;
  };

  function resolveUrl(source: SharedVersionMeta, file: string): string | undefined {
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
  // `remotes[0]` is the serving basis, ordered by entrypoint coverage: it says nothing about
  // what the version demands. Advertising its range would let MF hand a sibling a copy that
  // sibling's own range rejects, so a disagreement pins to the tag — the only value no remote
  // can reject, and the one the import map already commits to.
  const declared = new Set(version.remotes.map(r => r.requiredVersion));
  if (declared.size > 1) return version.tag;

  return version.remotes[0]?.requiredVersion || `^${version.tag}`;
}
