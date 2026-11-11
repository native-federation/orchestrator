import {
  type RemoteEntry,
  type RemoteInfo,
  type RemoteName,
  type ScopedVersion,
  type SharedExternal,
  type DenseSharedInfo,
  type RemoteSharedInfo,
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

export type RemoveCachedRemoteEntries = (remoteNames: ReadonlySet<RemoteName>) => void;

// Kept out of `storeRemoteEntry`: `removeFromAllScopes` traverses the whole shared-externals graph, so each
// caller evicts its whole set at once.
export function createRemoveCachedRemoteEntries(
  ports: Pick<
    DrivingContract,
    'remoteInfoRepo' | 'scopedExternalsRepo' | 'sharedExternalsRepo' | 'sharedChunksRepo'
  >
): RemoveCachedRemoteEntries {
  return remoteNames => {
    if (remoteNames.size === 0) return;

    for (const remoteName of remoteNames) {
      ports.remoteInfoRepo.remove(remoteName);
      ports.scopedExternalsRepo.remove(remoteName);
      ports.sharedChunksRepo.remove(remoteName);
    }
    ports.sharedExternalsRepo.removeFromAllScopes(remoteNames);
  };
}

export type SharedExternalHandler = (
  remoteEntry: RemoteEntry,
  external: DenseSharedInfo,
  ctx: SharedExternalContext
) => void;

export type SharedExternalContext = {
  tag: string;
  remote: SharedVersionMeta;
  readRecord: () => SharedExternal;
  scopeType: 'global' | 'strict' | 'shareScope';
  assertSameVersionCompatibility: (matchingVersion: SharedVersion) => void;
  write: () => void;
};

// Shared by the init and dynamic storage steps, which must stay separate (docs/version-resolver.md "Dynamic
// Init"): if a change needs a flag here to serve only one caller, inline this back into the steps instead.
// Every entry is merged additively; evicting an overridden remote is the caller's job.
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
    addRemoteInfoToStorage(remoteEntry);
    addExternalsToStorage(remoteEntry, onSharedExternal);
    addSharedChunksToStorage(remoteEntry);
  };

  function addRemoteInfoToStorage({ name, url, exposes, integrity }: RemoteEntry): void {
    ports.remoteInfoRepo.addOrUpdate(name, {
      scopeUrl: _path.getScope(url),
      exposes: Object.values(exposes ?? []).map(m => {
        // Only the static closure is certain to be needed; lazy rows are left to the module's own import().
        const chunks = Object.values(m.chunks ?? {})
          .filter(c => c.initial)
          .map(c => c.file);
        return {
          moduleName: m.key,
          file: m.outFileName,
          ...(chunks.length ? { chunks } : {}),
        };
      }),
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
        if (
          external.requiredVersion &&
          !ports.versionCheck.isCompatible(tag, external.requiredVersion)
        )
          config.log.warn(
            logStep,
            `[${remoteEntry.name}][${external.packageName}] requiredVersion '${external.requiredVersion}' excludes its own version '${tag}'; '${tag}' is still accepted for it.`
          );
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
    const { packageName, entries } = sharedInfo;
    // Split records (#134) never share an entrypoint, so keying a root-less one by its first keeps them all.
    const key = packageName in entries ? packageName : (Object.keys(entries)[0] ?? packageName);
    ports.scopedExternalsRepo.addExternal(remoteEntry.name, key, {
      tag,
      bundle: sharedInfo.bundle,
      entries,
      ...(sharedInfo.preload ? { preload: true as const } : {}),
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
    sharedInfo: RemoteSharedInfo,
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
      ...(sharedInfo.dense ? { dense: true as const } : {}),
      entries: sharedInfo.entries,
      ...(sharedInfo.preload ? { preload: true as const } : {}),
      ...(sharedInfo.dev ? { dev: true as const } : {}),
    };

    // Read on first use: a runtime load stores its copies only after deciding them all, and an entry may list
    // one external twice (one row per tag).
    let stored: SharedExternal | undefined;
    const readRecord = (): SharedExternal =>
      (stored ??= ports.sharedExternalsRepo
        .tryGet(sharedInfo.packageName, sharedInfo.shareScope)
        .get() ?? { dirty: false, versions: [] });

    return {
      tag,
      remote,
      readRecord,
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
      write(): void {
        ports.sharedExternalsRepo.addOrUpdate(
          sharedInfo.packageName,
          {
            ...readRecord(),
            versions: readRecord().versions.sort((a, b) =>
              ports.versionCheck.compare(b.tag, a.tag)
            ),
          },
          sharedInfo.shareScope
        );
      },
    };
  }
}
