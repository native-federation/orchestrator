import type { ImportMap } from 'lib/1.domain/import-map/import-map.contract';
import type { RemoteEntry, SharedInfoActions } from 'lib/1.domain';
import type { LoggingConfig } from '../../config/log.contract';
import * as _path from 'lib/utils/path';
import type { ForConvertingToImportMap } from 'lib/2.app/driver-ports/dynamic-init/for-converting-to-import-map';
import type { DrivingContract } from 'lib/sdk.index';
import { toChunkImport } from '@softarc/native-federation/domain';

export function createConvertToImportMap(
  { log }: LoggingConfig,
  ports: Pick<DrivingContract, 'sharedChunksRepo'>
): ForConvertingToImportMap {
  return ({ entry, actions }) => {
    const importMap: ImportMap = { imports: {} };

    addExternals(entry, actions, importMap);
    addRemoteInfos(entry, importMap);
    log.debug(9, `[${entry.name}] Processed actions:`, actions);
    return Promise.resolve(importMap);
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
        const url = _path.join(remoteEntryScope, external.outFileName);
        addToScopes(remoteEntryScope, external.packageName, url, importMap);
        addIntegrity(importMap, url, integrityMap, external.outFileName);
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

      // Skipped shared externals
      if (actions[external.packageName]!.action === 'skip') {
        if (!external.shareScope) return;

        if (actions[external.packageName]!.override) {
          addToScopes(
            remoteEntryScope,
            external.packageName,
            actions[external.packageName]!.override!,
            importMap
          );
          return;
        }
      }

      // Chunks for shared externals
      if (external?.bundle) chunkBundles.add(external?.bundle);

      //  Scoped shared externals
      if (actions[external.packageName]!.action === 'scope') {
        const url = _path.join(remoteEntryScope, external.outFileName);
        addToScopes(remoteEntryScope, external.packageName, url, importMap);
        addIntegrity(importMap, url, integrityMap, external.outFileName);
        return;
      }

      // Shared externals with shareScope
      if (external.shareScope) {
        const url = _path.join(remoteEntryScope, external.outFileName);
        addToScopes(remoteEntryScope, external.packageName, url, importMap);
        addIntegrity(importMap, url, integrityMap, external.outFileName);
        return;
      }

      // Default case: shared globally
      const url = _path.join(remoteEntryScope, external.outFileName);
      importMap.imports[external.packageName] = url;
      addIntegrity(importMap, url, integrityMap, external.outFileName);
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
