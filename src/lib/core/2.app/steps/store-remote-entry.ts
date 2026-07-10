import {
  type RemoteEntry,
  type RemoteInfo,
  type ScopedVersion,
  type SharedExternal,
  type DenseSharedInfo,
  type SharedVersion,
  type SharedVersionMeta,
} from 'lib/core/1.domain';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { NFError } from 'lib/core/native-federation.error';
import * as _path from 'lib/utils/path';

export type StoreRemoteEntry = (
  remoteEntry: RemoteEntry,
  onSharedExternal: SharedExternalHandler
) => void;

export type SharedExternalHandler = (
  remoteEntry: RemoteEntry,
  external: DenseSharedInfo,
  ctx: SharedExternalContext
) => void;

export type SharedExternalContext = {
  tag: string;
  remote: SharedVersionMeta;
  cached: SharedExternal;
  scopeType: 'global' | 'strict' | 'shareScope';
  assertSameVersionCompatibility: (matchingVersion: SharedVersion) => void;
  commit: () => void;
};

/**
 * Not a pipeline step but the template both storage steps specialize: it owns the full
 * storage sequence for a remoteEntry, and only the resolution of a singleton external
 * differs between the init pipeline (process-remote-entries, step 2) and the dynamic
 * pipeline (update-cache, step 8), injected per call. The pipelines must not be merged,
 * see docs/version-resolver.md "Dynamic Init". If a change ever needs a flag or
 * parameter here to serve only one caller, inline this back into the steps instead.
 */
export function createStoreRemoteEntry(
  config: LoggingConfig & ModeConfig,
  ports: Pick<
    DrivingContract,
    | 'remoteInfoRepo'
    | 'scopedExternalsRepo'
    | 'sharedExternalsRepo'
    | 'sharedChunksRepo'
    | 'versionCheck'
  >,
  logStep: number
): StoreRemoteEntry {
  return (remoteEntry, onSharedExternal) => {
    if (remoteEntry?.override) removeCachedRemoteEntry(remoteEntry);
    addRemoteInfoToStorage(remoteEntry);
    addExternalsToStorage(remoteEntry, onSharedExternal);
    addSharedChunksToStorage(remoteEntry);
  };

  function removeCachedRemoteEntry(remoteEntry: RemoteEntry): void {
    ports.remoteInfoRepo.remove(remoteEntry.name);
    ports.scopedExternalsRepo.remove(remoteEntry.name);
    ports.sharedExternalsRepo.removeFromAllScopes(remoteEntry.name);
  }

  function addRemoteInfoToStorage({ name, url, exposes, integrity }: RemoteEntry): void {
    ports.remoteInfoRepo.addOrUpdate(name, {
      scopeUrl: _path.getScope(url),
      exposes: Object.values(exposes ?? []).map(m => ({
        moduleName: m.key,
        file: m.outFileName,
      })),
      ...(integrity ? { integrity } : {}),
    } as RemoteInfo);
  }

  function addExternalsToStorage(
    remoteEntry: RemoteEntry,
    onSharedExternal: SharedExternalHandler
  ): void {
    remoteEntry.shared.forEach(external => {
      const tag = resolveVersion(remoteEntry, external);
      if (tag === null) return;

      if (external.singleton) {
        if (external.pool?.trim()) ports.sharedExternalsRepo.markPoolTagPresent();
        onSharedExternal(remoteEntry, external, sharedExternalContext(remoteEntry, external, tag));
      } else {
        addScopedExternal(remoteEntry, external, tag);
      }
    });
  }

  function addSharedChunksToStorage(remoteEntry: RemoteEntry): void {
    if (!remoteEntry.chunks) return;
    config.log.debug(
      logStep,
      `Adding chunks for remote "${remoteEntry.name}", bundles: [${Object.keys(remoteEntry.chunks).join(', ')}]`
    );
    Object.entries(remoteEntry.chunks).forEach(([bundleName, chunks]) => {
      ports.sharedChunksRepo.addOrReplace(remoteEntry.name, bundleName, chunks);
    });
  }

  function addScopedExternal(
    remoteEntry: RemoteEntry,
    sharedInfo: DenseSharedInfo,
    tag: string
  ): void {
    ports.scopedExternalsRepo.addExternal(remoteEntry.name, sharedInfo.packageName, {
      tag,
      bundle: sharedInfo.bundle,
      entries: sharedInfo.entries,
    } as ScopedVersion);
  }

  function resolveVersion(remoteEntry: RemoteEntry, external: DenseSharedInfo): string | null {
    if (external.version && ports.versionCheck.isValidSemver(external.version)) {
      return external.version;
    }

    const errorMsg = `[${remoteEntry.name}][${external.packageName}] Version '${external.version}' is not a valid version.`;
    if (config.strict.strictExternalVersion) {
      config.log.error(logStep, errorMsg);
      throw new NFError(`Could not process remote '${remoteEntry.name}'`);
    }
    if (config.profile.skipInvalidExternalVersions) {
      config.log.warn(logStep, `${errorMsg} Skipping external.`);
      return null;
    }
    config.log.warn(logStep, errorMsg);
    return ports.versionCheck.smallestVersion(external.requiredVersion);
  }

  function sharedExternalContext(
    remoteEntry: RemoteEntry,
    sharedInfo: DenseSharedInfo,
    tag: string
  ): SharedExternalContext {
    const scopeType = ports.sharedExternalsRepo.scopeType(sharedInfo.shareScope);

    const remote: SharedVersionMeta = {
      name: remoteEntry.name,
      bundle: sharedInfo.bundle,
      strictVersion: sharedInfo.strictVersion,
      cached: false,
      requiredVersion: scopeType === 'strict' ? tag : sharedInfo.requiredVersion || tag,
      ...(sharedInfo.pool?.trim() ? { pool: sharedInfo.pool } : {}),
      entries: sharedInfo.entries,
    };

    const cached: SharedExternal = ports.sharedExternalsRepo
      .tryGet(sharedInfo.packageName, sharedInfo.shareScope)
      .orElse({ dirty: false, versions: [] });

    return {
      tag,
      remote,
      cached,
      scopeType,
      assertSameVersionCompatibility(matchingVersion: SharedVersion): void {
        if (!remote.strictVersion) return;
        if (matchingVersion.remotes[0]!.requiredVersion === remote.requiredVersion) return;

        const errorMsg = `[${remoteEntry.name}][${sharedInfo.packageName}@${
          sharedInfo.version
        }] Required version-range '${
          remote.requiredVersion
        }' does not match cached version-range '${matchingVersion.remotes[0]!.requiredVersion}'`;

        if (config.strict.strictExternalSameVersionCompatibility) {
          config.log.error(logStep, errorMsg);
          throw new NFError(`Could not process remote '${remoteEntry.name}'`);
        }
        config.log.warn(logStep, errorMsg);
      },
      commit(): void {
        ports.sharedExternalsRepo.addOrUpdate(
          sharedInfo.packageName,
          {
            dirty: cached.dirty,
            versions: cached.versions.sort((a, b) => ports.versionCheck.compare(b.tag, a.tag)),
          },
          sharedInfo.shareScope
        );
      },
    };
  }
}
