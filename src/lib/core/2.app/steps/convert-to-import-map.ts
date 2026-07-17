import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';
import { type RemoteEntry, type SharedInfoActions } from 'lib/core/1.domain';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';
import * as _path from 'lib/utils/path';
import type { ForConvertingToImportMap } from 'lib/core/2.app/driver-ports/init/for-converting-to-import-map';
import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
import { NFError } from 'lib/core/native-federation.error';
import { toChunkImport } from '@softarc/native-federation/domain';

export function createConvertToImportMap(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedChunksRepo'>
): ForConvertingToImportMap {
  const { log } = config;
  return async ({ entry, actions }) => {
    const importMap: ImportMap = { imports: {} };

    addExternals(entry, actions, importMap);
    addRemoteInfos(entry, importMap);
    log.debug(9, `[${entry.name}] Processed actions:`, actions);
    return importMap;
  };

  function addExternals(
    remoteEntry: RemoteEntry,
    actions: SharedInfoActions,
    importMap: ImportMap
  ): void {
    if (!remoteEntry.shared) {
      return;
    }

    const remoteEntryScope = _path.getScope(remoteEntry.url);
    const integrityMap = remoteEntry.integrity;

    const chunkBundles = new Set<string>(['mapping-or-exposed']);
    remoteEntry.shared.forEach(external => {
      // Scoped externals
      if (!external.singleton) {
        Object.entries(external.entries).forEach(([packageName, fileName]) => {
          const url = _path.join(remoteEntryScope, fileName);
          addToScopes(remoteEntryScope, packageName, url, importMap);
          addIntegrity(importMap, url, integrityMap, fileName);
        });

        if (external?.bundle) chunkBundles.add(external?.bundle);
        return;
      }

      if (!actions[external.packageName]) {
        log.warn(
          9,
          `[${remoteEntry.name}] No action defined for shared external '${external.packageName}', skipping.`
        );
        return;
      }

      // Skipped externals are provided by another remote. A global skip is served
      // by the global share elsewhere; a shareScope skip is always paired with an
      // override (see update-cache) that remaps its entrypoints.
      if (actions[external.packageName]!.action === 'skip') {
        const override = actions[external.packageName]!.override;
        if (!external.shareScope) return;
        if (override) {
          Object.entries(override).forEach(([packageName, url]) => {
            addToScopes(remoteEntryScope, packageName, url, importMap);
          });
          // Entrypoints the override can't supply are served from this remote's own build.
          Object.entries(external.entries).forEach(([packageName, fileName]) => {
            if (packageName in override) return;
            if (config.strict.strictEntryPointCoverage) {
              warnUncoveredEntrypoint(remoteEntry.name, external.packageName, packageName);
              return;
            }
            const url = _path.join(remoteEntryScope, fileName);
            addToScopes(remoteEntryScope, packageName, url, importMap);
            addIntegrity(importMap, url, integrityMap, fileName);
          });
          return;
        }
        // Reaching here means the resolver failed to produce the expected override.
        log.error(
          9,
          `[${remoteEntry.name}][${external.packageName}] shareScope skip has no override.`
        );
        if (config.strict.strictImportMap) throw new NFError('Could not create ImportMap.');
        // Non-strict fallback: serve from the remote's own scope (matches init).
        Object.entries(external.entries).forEach(([packageName, fileName]) => {
          const url = _path.join(remoteEntryScope, fileName);
          addToScopes(remoteEntryScope, packageName, url, importMap);
          addIntegrity(importMap, url, integrityMap, fileName);
        });
        return;
      }

      // Chunks for shared externals
      if (external?.bundle) chunkBundles.add(external?.bundle);

      //  Scoped shared externals
      if (actions[external.packageName]!.action === 'scope') {
        Object.entries(external.entries).forEach(([packageName, fileName]) => {
          const url = _path.join(remoteEntryScope, fileName);
          addToScopes(remoteEntryScope, packageName, url, importMap);
          addIntegrity(importMap, url, integrityMap, fileName);
        });
        return;
      }

      // Shared externals with shareScope
      if (external.shareScope) {
        Object.entries(external.entries).forEach(([packageName, fileName]) => {
          const url = _path.join(remoteEntryScope, fileName);
          addToScopes(remoteEntryScope, packageName, url, importMap);
          addIntegrity(importMap, url, integrityMap, fileName);
        });
        return;
      }

      // Default case: shared globally
      Object.entries(external.entries).forEach(([packageName, fileName]) => {
        const url = _path.join(remoteEntryScope, fileName);
        importMap.imports[packageName] = url;

        addIntegrity(importMap, url, integrityMap, fileName);
      });
    });

    addChunkImports(importMap, remoteEntry, remoteEntryScope, chunkBundles);
  }

  function addToScopes(
    scope: string,
    packageName: string,
    url: string,
    importMap: ImportMap
  ): void {
    if (!importMap.scopes) importMap.scopes = {};
    if (!importMap.scopes[scope]) importMap.scopes[scope] = {};
    importMap.scopes[scope][packageName] = url;
  }

  function addRemoteInfos(remoteEntry: RemoteEntry, importMap: ImportMap): void {
    if (!remoteEntry.exposes) return;
    const scope = _path.getScope(remoteEntry.url);

    remoteEntry.exposes.forEach(exposed => {
      const moduleName = _path.join(remoteEntry.name, exposed.key);
      const moduleUrl = _path.join(scope, exposed.outFileName);
      importMap.imports[moduleName] = moduleUrl;
      addIntegrity(importMap, moduleUrl, remoteEntry.integrity, exposed.outFileName);
    });
  }

  function addChunkImports(
    importMap: ImportMap,
    remoteEntry: RemoteEntry,
    remoteEntryScope: string,
    chunkBundles: Set<string>
  ) {
    Array.from(chunkBundles).forEach(bundleName => {
      ports.sharedChunksRepo.tryGet(remoteEntry.name, bundleName).ifPresent(files => {
        files.forEach(file => {
          const url = _path.join(remoteEntryScope, file);
          addToScopes(remoteEntryScope, toChunkImport(file), url, importMap);
          addIntegrity(importMap, url, remoteEntry.integrity, file);
        });
      });
    });
    return importMap;
  }

  function warnUncoveredEntrypoint(
    remoteName: string,
    externalName: string,
    packageName: string
  ): void {
    const msg = `[${remoteName}][${externalName}] Entrypoint '${packageName}' is not covered by the override.`;
    if (config.strict.strictImportMap) {
      log.error(9, msg);
      throw new NFError('Could not create ImportMap.');
    }
    log.warn(9, msg);
  }

  function addIntegrity(
    importMap: ImportMap,
    url: string,
    integrityMap: Record<string, string> | undefined,
    file: string
  ): void {
    const hash = integrityMap?.[file];
    if (!hash) return;
    if (!importMap.integrity) importMap.integrity = {};
    importMap.integrity[url] = hash;
  }
}
