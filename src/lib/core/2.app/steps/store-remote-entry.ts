import type {
  RemoteEntry,
  RemoteInfo,
  ScopedVersion,
  SharedExternal,
  SharedInfo,
  SharedVersion,
  SharedVersionMeta,
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
  external: SharedInfo,
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
      validateExternalVersion(remoteEntry, external);
      if (external.singleton) {
        onSharedExternal(remoteEntry, external, sharedExternalContext(remoteEntry, external));
      } else {
        addScopedExternal(remoteEntry, external);
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

  function addScopedExternal(remoteEntry: RemoteEntry, sharedInfo: SharedInfo): void {
    ports.scopedExternalsRepo.addExternal(remoteEntry.name, sharedInfo.packageName, {
      tag: sharedInfo.version ?? ports.versionCheck.smallestVersion(sharedInfo.requiredVersion),
      file: sharedInfo.outFileName,
      bundle: sharedInfo.bundle,
    } as ScopedVersion);
  }

  function validateExternalVersion(remoteEntry: RemoteEntry, external: SharedInfo): void {
    if (!external.version || !ports.versionCheck.isValidSemver(external.version)) {
      const errorMsg = `[${remoteEntry.name}][${external.packageName}] Version '${external.version}' is not a valid version.`;

      if (config.strict.strictExternalVersion) {
        config.log.error(logStep, errorMsg);
        throw new NFError(`Could not process remote '${remoteEntry.name}'`);
      }
      config.log.warn(logStep, errorMsg);
    }
  }

  function sharedExternalContext(
    remoteEntry: RemoteEntry,
    sharedInfo: SharedInfo
  ): SharedExternalContext {
    const tag =
      sharedInfo.version ?? ports.versionCheck.smallestVersion(sharedInfo.requiredVersion);
    const scopeType = ports.sharedExternalsRepo.scopeType(sharedInfo.shareScope);

    const remote: SharedVersionMeta = {
      file: sharedInfo.outFileName,
      name: remoteEntry.name,
      bundle: sharedInfo.bundle,
      strictVersion: sharedInfo.strictVersion,
      cached: false,
      requiredVersion: scopeType === 'strict' ? tag : sharedInfo.requiredVersion || tag,
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
