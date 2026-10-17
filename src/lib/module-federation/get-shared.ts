import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
import type { ForSharedExternalsStorage } from 'lib/core/2.app/driving-ports/for-shared-externals-storage.port';
import type { SharedExternal, SharedVersion, SharedVersionMeta } from 'lib/core/1.domain';
import { claimTable } from 'lib/core/1.domain/externals/claims';
import { servedScopes } from 'lib/core/1.domain/externals/serving';
import type { Specifier } from 'lib/core/1.domain/externals/specifier';
import type { GetSharedOptions, ShareInfos, Shared } from './share-infos.contract';
import * as _path from 'lib/utils/path';

type ScopeType = ReturnType<ForSharedExternalsStorage['scopeType']>;

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

      for (const { specifier, version, source } of sharedEntrypoints(externals, scopeType)) {
        const url = resolveUrl(source, source.entries[specifier]!);
        if (!url) continue;

        const shareObject: Shared = {
          version: version.tag,
          get: () => ports.browser.importModule(url).then(module => () => module),
          shareConfig: {
            singleton: scopeType === 'strict' ? false : (options.singleton ?? true),
            requiredVersion: resolveRequiredVersion(version, options, scopeType),
            ...(scopeType === 'strict' ? { strictVersion: true } : {}),
          },
        };
        if (scopeType !== 'global') shareObject.scope = scope;

        if (!shared[specifier]) shared[specifier] = [];
        shared[specifier]!.push(shareObject);
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

type SharedEntrypoint = { specifier: Specifier; version: SharedVersion; source: SharedVersionMeta };

function sharedEntrypoints(
  externals: Record<string, SharedExternal>,
  scopeType: ScopeType
): SharedEntrypoint[] {
  const view = scopeType === 'global' ? 'claims' : 'shareClaims';
  return servedScopes(externals, scopeType === 'strict').flatMap(served =>
    servedEntrypoints(served, view)
  );
}

// One singleton per specifier, from the build the import map serves it from.
function servedEntrypoints(
  externals: Record<string, SharedExternal>,
  view: 'claims' | 'shareClaims'
): SharedEntrypoint[] {
  return [...claimTable(Object.entries(externals))[view]].map(
    ([specifier, { external, tag, copy }]) => ({
      specifier,
      version: externals[external]!.versions.find(v => v.action === 'share' && v.tag === tag)!,
      source: copy,
    })
  );
}

function resolveRequiredVersion(
  version: SharedVersion,
  options: GetSharedOptions,
  scopeType: ScopeType
): string {
  // Strict shares a specific version, not a range: pin to the exact tag so a
  // consumer reuses only that version (MF matches via satisfy(version, required)).
  if (scopeType === 'strict') return version.tag;
  if (typeof options.requiredVersionPrefix === 'string') {
    return `${options.requiredVersionPrefix}${version.tag}`;
  }
  // The copy MF hands out says nothing about what the version demands. Advertising its range would let MF
  // hand a sibling a copy that sibling's own range rejects, so a disagreement pins to the tag — the only value
  // no remote can reject, and the one the import map already commits to.
  const declared = new Set(version.remotes.map(r => r.requiredVersion));
  if (declared.size > 1) return version.tag;

  return version.remotes[0]?.requiredVersion || `^${version.tag}`;
}
