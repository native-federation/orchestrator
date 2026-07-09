import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';
import { type RemoteEntry, type SharedInfoActions, sharedInfoEntries } from 'lib/core/1.domain';
import type { LoggingConfig } from '../config/log.contract';
import * as _path from 'lib/utils/path';
import type { ForConvertingToImportMap } from 'lib/core/2.app/driver-ports/init/for-converting-to-import-map';
import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
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
        const entries = sharedInfoEntries(external);

        Object.entries(entries).forEach(([packageName, fileName]) => {
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

      // Skipped externals are provided by another remote; only a shareScope override
      // remaps their entrypoints, otherwise skip.
      if (actions[external.packageName]!.action === 'skip') {
        const override = actions[external.packageName]!.override;
        if (external.shareScope && override) {
          Object.entries(override).forEach(([packageName, url]) => {
            addToScopes(remoteEntryScope, packageName, url, importMap);
          });
        }
        return;
      }

      // Chunks for shared externals
      if (external?.bundle) chunkBundles.add(external?.bundle);

      //  Scoped shared externals
      if (actions[external.packageName]!.action === 'scope') {
        const entries = sharedInfoEntries(external);
        Object.entries(entries).forEach(([packageName, fileName]) => {
          const url = _path.join(remoteEntryScope, fileName);
          addToScopes(remoteEntryScope, packageName, url, importMap);
          addIntegrity(importMap, url, integrityMap, fileName);
        });
        return;
      }

      // Shared externals with shareScope
      if (external.shareScope) {
        const entries = sharedInfoEntries(external);
        Object.entries(entries).forEach(([packageName, fileName]) => {
          const url = _path.join(remoteEntryScope, fileName);
          addToScopes(remoteEntryScope, packageName, url, importMap);
          addIntegrity(importMap, url, integrityMap, fileName);
        });
        return;
      }

      // Default case: shared globally
      const entries = sharedInfoEntries(external);
      Object.entries(entries).forEach(([packageName, fileName]) => {
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
