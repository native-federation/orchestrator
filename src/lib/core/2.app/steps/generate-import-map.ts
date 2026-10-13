import type { ForGeneratingImportMap } from '../driver-ports/init/for-generating-import-map';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { ImportMap, Imports } from 'lib/core/1.domain/import-map/import-map.contract';
import {
  GLOBAL_SCOPE,
  type RemoteName,
  type ScopedExternal,
  type RemoteInfo,
  type SharedExternal,
  type SharedVersion,
  type SharedVersionMeta,
} from 'lib/core/1.domain';
import { versionEntries } from 'lib/core/1.domain/externals/basis';
import { claimTable, type Claim } from 'lib/core/1.domain/externals/claims';
import type { Specifier } from 'lib/core/1.domain/externals/specifier';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';
import * as _path from 'lib/utils/path';
import { NFError } from 'lib/core/native-federation.error';
import { toChunkImport } from '@softarc/native-federation/domain';

export function createGenerateImportMap(
  config: LoggingConfig & ModeConfig,
  ports: Pick<
    DrivingContract,
    'remoteInfoRepo' | 'scopedExternalsRepo' | 'sharedChunksRepo' | 'sharedExternalsRepo'
  >
): ForGeneratingImportMap {
  /**
   * Step 4: Generate an importMap from the cached remoteEntries
   *
   * The processed externals in the storage/cache (step 2 & 3) are used
   * to generate an importMap. The step returns the generated importMap object.
   */
  return () => {
    const importMap: ImportMap = { imports: {} };
    const chunkBundles: Record<string, Set<string>> = {};
    try {
      addScopedExternals(importMap, chunkBundles);
      addNamedShareScopes(importMap, chunkBundles);
      addGlobalShareScope(importMap, chunkBundles);
      addRemoteInfos(importMap, chunkBundles);

      addChunkImports(importMap, chunkBundles);

      return Promise.resolve(importMap);
    } catch (e) {
      return Promise.reject(e);
    }
  };

  /**
   * Step 4.1: Begin with appending smallest scope of shared dependencies
   * @param importMap
   * @returns
   */
  function addScopedExternals(
    importMap: ImportMap,
    chunkBundles: Record<string, Set<string>>
  ): ImportMap {
    const scopedExternals = ports.scopedExternalsRepo.getAll();

    for (const [remoteName, externals] of Object.entries(scopedExternals)) {
      const remote = ports.remoteInfoRepo.tryGet(remoteName).orThrow(() => {
        config.log.error(4, `[scoped][${remoteName}] Remote name not found in cache.`);
        return new NFError('Could not create ImportMap.');
      });
      addToScope(importMap, remote.scopeUrl, createScopeModules(externals, remote.scopeUrl));

      for (const version of Object.values(externals)) {
        for (const file of Object.values(version.entries)) {
          addIntegrity(importMap, _path.join(remote.scopeUrl, file), remoteName, file);
        }
      }

      Object.values(externals)
        .filter(e => !!e.bundle)
        .forEach(e => registerBundleChunks(chunkBundles, remoteName, e.bundle));
    }

    return importMap;
  }

  function createScopeModules(externals: ScopedExternal, scope: string): Imports {
    const modules: Imports = {};

    for (const version of Object.values(externals)) {
      for (const [packageName, file] of Object.entries(version.entries)) {
        modules[packageName] = _path.join(scope, file);
      }
    }

    return modules;
  }

  // Runs after the scoped externals, so a remote's shared mappings overwrite its scoped ones in its scope.
  function addNamedShareScopes(
    importMap: ImportMap,
    chunkBundles: Record<string, Set<string>>
  ): ImportMap {
    const shareScopes = ports.sharedExternalsRepo.getScopes({ includeGlobal: false });

    for (const shareScope of shareScopes) {
      addShareScope(importMap, shareScope, chunkBundles);
    }

    return importMap;
  }

  function addShareScope(
    importMap: ImportMap,
    shareScope: string,
    chunkBundles: Record<string, Set<string>>
  ): void {
    const sharedExternals = ports.sharedExternalsRepo.getFromScope(shareScope);
    const index = buildServedIndex(sharedExternals);

    const claims = shareRowMappings(sharedExternals, shareScope);
    const claimedElsewhere = (externalName: string, specifier: string): Mapping | undefined => {
      const claim = claims.get(specifier);
      return claim?.external === externalName ? undefined : claim;
    };

    for (const [externalName, external] of Object.entries(sharedExternals)) {
      let override: SharedVersion | undefined | 'NOT_AVAILABLE' = undefined;
      const cachedBefore = cachedFingerprint(external);

      for (const version of external.versions) {
        if (version.action === 'scope') {
          addScopeRow(importMap, chunkBundles, shareScope, externalName, version);
          continue;
        }

        // Serve every entrypoint from one version: this one, or the override version when a
        // 'skip' is redirected elsewhere. Within a version the copies merge, so the surface is
        // the union of what they bundle, each specifier from the copy that declares it.
        let serving = version;

        if (version.action === 'skip') {
          if (!override) {
            override =
              findOverride(external, shareScope, externalName, s =>
                Boolean(claimedElsewhere(externalName, s))
              ) ?? 'NOT_AVAILABLE';
          }
          if (override !== 'NOT_AVAILABLE') {
            serving = override;
            version.remotes[0]!.cached = false;
          }
        }

        const provided = versionEntries(serving);
        const mappings: (Mapping & { packageName: string })[] = [];

        for (const [packageName, provider] of provided) {
          // The claiming external maps, marks and registers that copy; this one only points at it.
          const claim = claimedElsewhere(externalName, packageName);
          if (claim) {
            mappings.push({ packageName, ...claim });
            continue;
          }
          const file = provider.entries[packageName]!;
          mappings.push({
            packageName,
            url: _path.join(getScope(shareScope, provider.name, externalName), file),
            name: provider.name,
            file,
          });
          provider.cached = true;
          if (version.action === 'share') {
            registerBundleChunks(chunkBundles, provider.name, provider.bundle);
          }
        }

        version.remotes.forEach(consumer => {
          const consumerScope = getScope(shareScope, consumer.name, externalName);
          // Pooling placed this remote in a subpool, so its scope names that subpool's build's files for
          // everything it imports rather than the shared source's.
          if (index && consumer.servedBy) {
            const files = index.get(consumer.servedBy);
            const servedScope = getScope(shareScope, consumer.servedBy, externalName);
            for (const specifier of Object.keys(consumer.entries)) {
              const source = files?.get(specifier);
              if (!source) continue;
              const url = _path.join(servedScope, source.file);
              addToScope(importMap, consumerScope, { [specifier]: url });
              addIntegrity(importMap, url, consumer.servedBy, source.file);
              registerBundleChunks(chunkBundles, consumer.servedBy, source.bundle);
              source.meta.cached = true;
            }
            return;
          }
          for (const m of mappings) {
            addToScope(importMap, consumerScope, { [m.packageName]: m.url });
          }
          // Entrypoints no copy of the serving version has are served from this remote's own build.
          for (const [packageName, file] of Object.entries(consumer.entries)) {
            if (provided.has(packageName)) continue;
            const claim = claimedElsewhere(externalName, packageName);
            if (claim) {
              addToScope(importMap, consumerScope, { [packageName]: claim.url });
              continue;
            }
            const url = _path.join(consumerScope, file);
            addToScope(importMap, consumerScope, { [packageName]: url });
            addIntegrity(importMap, url, consumer.name, file);
            consumer.cached = true;
          }
        });
        for (const m of mappings) {
          addIntegrity(importMap, m.url, m.name, m.file);
        }
      }
      if (cachedFingerprint(external) !== cachedBefore) {
        ports.sharedExternalsRepo.addOrUpdate(externalName, external, shareScope);
      }
    }
  }

  function addScopeRow(
    importMap: ImportMap,
    chunkBundles: Record<string, Set<string>>,
    shareScope: string,
    externalName: string,
    version: SharedVersion
  ): void {
    for (const remote of version.remotes) {
      const remoteScope = getScope(shareScope, remote.name, externalName);
      for (const [packageName, file] of Object.entries(remote.entries)) {
        const url = _path.join(remoteScope, file);
        addToScope(importMap, remoteScope, { [packageName]: url });
        addIntegrity(importMap, url, remote.name, file);
      }
      registerBundleChunks(chunkBundles, remote.name, remote.bundle);
      remote.cached = true;
    }
  }

  function cachedFingerprint(external: SharedExternal): string {
    return external.versions.map(v => v.remotes.map(r => (r.cached ? 1 : 0)).join('')).join('|');
  }

  // A skip-only external whose specifiers another external's shared version maps is served all the same.
  function findOverride(
    external: SharedExternal,
    shareScope: string,
    externalName: string,
    servedElsewhere: (specifier: string) => boolean
  ): SharedVersion | undefined {
    const sharedVersions = external.versions.filter(v => v.action === 'share');
    const scopedExternalName = `${shareScope}.${externalName}`;

    if (sharedVersions.length > 1) {
      handleMultipleSharedVersions(scopedExternalName);
    }

    const servedByClaims = () =>
      external.versions
        .filter(v => v.action === 'skip')
        .every(v => [...versionEntries(v).keys()].every(servedElsewhere));

    if (sharedVersions.length < 1 && !servedByClaims()) {
      if (config.strict.strictImportMap) {
        config.log.error(4, `[${shareScope}][${externalName}] shareScope has no override version.`);
        throw new NFError('Could not create ImportMap.');
      }
      config.log.debug(
        4,
        `[${shareScope}][${externalName}] shareScope has no override version, scoping override versions.`
      );
    }

    return sharedVersions[0];
  }

  function handleMultipleSharedVersions(scopedExternalName: string): void {
    if (config.strict.strictImportMap) {
      config.log.error(
        4,
        `[${scopedExternalName}] ShareScope external has multiple shared versions.`
      );
      throw new NFError('Could not create ImportMap.');
    }

    config.log.warn(4, `ShareScope external ${scopedExternalName} has multiple shared versions.`);
  }

  /**
   * Where a build serves a specifier from, per remote — built only when some copy carries a `servedBy`,
   * so an unpooled portfolio allocates nothing. Pool-wide rather than per-external on purpose: the
   * specifier a subpool member runs may be an *entry* of a different external of the serving build,
   * which is the whole reason coverage is keyed by specifier (see docs/version-resolver.md §"How pooling
   * resolves", "Coverage is keyed by specifier").
   */
  type ServedSource = { file: string; bundle?: string; meta: SharedVersionMeta };

  function buildServedIndex(
    externals: Record<string, SharedExternal>
  ): Map<RemoteName, Map<string, ServedSource>> | undefined {
    let anyServed = false;
    for (const external of Object.values(externals)) {
      for (const version of external.versions) {
        if (version.remotes.some(r => r.servedBy)) anyServed = true;
      }
    }
    if (!anyServed) return undefined;

    const index = new Map<RemoteName, Map<string, ServedSource>>();
    for (const external of Object.values(externals)) {
      for (const version of external.versions) {
        for (const remote of version.remotes) {
          let own = index.get(remote.name);
          if (!own) index.set(remote.name, (own = new Map()));
          for (const [specifier, file] of Object.entries(remote.entries)) {
            if (!own.has(specifier))
              own.set(specifier, { file, bundle: remote.bundle, meta: remote });
          }
        }
      }
    }
    return index;
  }

  type Mapping = { url: string; name: RemoteName; file: string };

  // A specifier can be an entry of one external and a package of its own in another (flat vs dense), and the
  // first shared version listing it serves every remote of the scope.
  function shareRowMappings(
    externals: Record<string, SharedExternal>,
    shareScope: string
  ): Map<Specifier, Mapping & { external: string }> {
    const mappings = new Map<Specifier, Mapping & { external: string }>();
    for (const [specifier, { external, copy }] of claimTable(Object.entries(externals))
      .shareClaims) {
      const file = copy.entries[specifier]!;
      mappings.set(specifier, {
        url: _path.join(getScope(shareScope, copy.name, external), file),
        name: copy.name,
        file,
        external,
      });
    }
    return mappings;
  }

  // A cross-build scope entry, held back until every global mapping is in place so that a scope which
  // would merely repeat `imports` can be dropped.
  type ServedScope = { scope: string; specifier: string; source: ServedSource; from: RemoteName };

  function collectServed(
    into: ServedScope[],
    index: Map<RemoteName, Map<string, ServedSource>>,
    shareScope: string,
    externalName: string,
    version: SharedVersion
  ): void {
    for (const consumer of version.remotes) {
      if (!consumer.servedBy) continue;
      const files = index.get(consumer.servedBy);
      const scope = getScope(shareScope, consumer.name, externalName);
      for (const specifier of Object.keys(consumer.entries)) {
        const source = files?.get(specifier);
        if (!source) {
          config.log.warn(
            4,
            `[${shareScope}][${externalName}][${consumer.name}] '${consumer.servedBy}' does not serve '${specifier}'.`
          );
          continue;
        }
        into.push({ scope, specifier, source, from: consumer.servedBy });
      }
    }
  }

  function flushServed(
    importMap: ImportMap,
    chunkBundles: Record<string, Set<string>>,
    served: ServedScope[]
  ): void {
    for (const { scope, specifier, source, from } of served) {
      const url = _path.join(getScope(GLOBAL_SCOPE, from), source.file);
      if (importMap.imports[specifier] === url) continue;
      addToScope(importMap, scope, { [specifier]: url });
      addIntegrity(importMap, url, from, source.file);
      registerBundleChunks(chunkBundles, from, source.bundle);
      source.meta.cached = true;
    }
  }

  function addGlobalShareScope(
    importMap: ImportMap,
    chunkBundles: Record<string, Set<string>>
  ): ImportMap {
    const sharedExternals = ports.sharedExternalsRepo.getFromScope();
    const index = buildServedIndex(sharedExternals);
    const { claims, duplicates } = claimTable(Object.entries(sharedExternals));
    const claimed = claimsByCopy(claims);
    const served: ServedScope[] = [];
    const cachedBefore = new Map<string, string>();

    for (const [externalName, external] of Object.entries(sharedExternals)) {
      cachedBefore.set(externalName, cachedFingerprint(external));

      for (const version of external.versions) {
        if (index && version.action !== 'scope') {
          collectServed(served, index, GLOBAL_SCOPE, externalName, version);
        }
        if (version.action === 'skip') continue;
        if (version.action === 'scope') {
          addScopeRow(importMap, chunkBundles, GLOBAL_SCOPE, externalName, version);
          continue;
        }

        if (duplicates.has(version)) {
          notifyDuplicateGlobalExternal(externalName);
          continue;
        }

        publishClaims(importMap, chunkBundles, externalName, version, claimed);
      }
    }

    flushServed(importMap, chunkBundles, served);

    for (const [externalName, external] of Object.entries(sharedExternals)) {
      if (cachedFingerprint(external) !== cachedBefore.get(externalName)) {
        ports.sharedExternalsRepo.addOrUpdate(externalName, external);
      }
    }

    return importMap;
  }

  function claimsByCopy(claims: Map<Specifier, Claim>): Map<SharedVersionMeta, Specifier[]> {
    const claimed = new Map<SharedVersionMeta, Specifier[]>();
    for (const [specifier, { copy }] of claims) {
      const specifiers = claimed.get(copy);
      if (specifiers) specifiers.push(specifier);
      else claimed.set(copy, [specifier]);
    }
    return claimed;
  }

  // Marks and registers each copy that claims a specifier, so `cached` names the copies this map really
  // publishes, which the dynamic path reads as what it may call covered.
  function publishClaims(
    importMap: ImportMap,
    chunkBundles: Record<string, Set<string>>,
    externalName: string,
    version: SharedVersion,
    claimed: Map<SharedVersionMeta, Specifier[]>
  ): void {
    for (const copy of version.remotes) {
      const specifiers = claimed.get(copy);
      if (!specifiers) continue;
      const scope = getScope(GLOBAL_SCOPE, copy.name, externalName);
      registerBundleChunks(chunkBundles, copy.name, copy.bundle);
      copy.cached = true;
      for (const specifier of specifiers) {
        const file = copy.entries[specifier]!;
        const url = _path.join(scope, file);
        addToGlobal(importMap, { [specifier]: url });
        addIntegrity(importMap, url, copy.name, file);
      }
    }
  }

  function notifyDuplicateGlobalExternal(externalName: string): void {
    if (config.strict.strictImportMap) {
      config.log.error(4, `[${externalName}] Shared external has multiple shared versions.`);
      throw new NFError('Could not create ImportMap.');
    }

    config.log.warn(4, `Singleton external ${externalName} has multiple shared versions.`);
  }

  function addToScope(importMap: ImportMap, scope: string, imports: Imports): void {
    if (!importMap.scopes) importMap.scopes = {};
    if (!importMap.scopes[scope]) importMap.scopes[scope] = {};
    importMap.scopes[scope] = Object.assign(importMap.scopes[scope], imports);
  }
  function addToGlobal(importMap: ImportMap, imports: Imports): void {
    importMap.imports = Object.assign(importMap.imports, imports);
  }

  /**
   * Step 4.4: Added the remote-modules (into the global scope).
   * @param importMap
   * @returns
   */
  function addRemoteInfos(importMap: ImportMap, chunkBundles: Record<string, Set<string>>): void {
    const remotes = ports.remoteInfoRepo.getAll();

    for (const [remoteName, remote] of Object.entries(remotes)) {
      addRemoteExposedModules(importMap, remoteName, remote);
      registerBundleChunks(chunkBundles, remoteName, 'mapping-or-exposed');
    }
  }

  function addRemoteExposedModules(
    importMap: ImportMap,
    remoteName: string,
    remote: RemoteInfo
  ): void {
    for (const exposed of remote.exposes) {
      const moduleName = _path.join(remoteName, exposed.moduleName);
      const moduleUrl = _path.join(remote.scopeUrl, exposed.file);
      importMap.imports[moduleName] = moduleUrl;
      addIntegrity(importMap, moduleUrl, remoteName, exposed.file);
    }
  }

  function registerBundleChunks(
    chunkBundles: Record<string, Set<string>>,
    remoteName: string,
    bundleName?: string
  ) {
    if (!bundleName) return chunkBundles;
    if (!chunkBundles[remoteName]) chunkBundles[remoteName] = new Set();
    chunkBundles[remoteName].add(bundleName);
    return chunkBundles;
  }

  function addChunkImports(importMap: ImportMap, chunkBundles: Record<string, Set<string>>) {
    Object.entries(chunkBundles).forEach(([remoteName, bundles]) => {
      const baseUrl = getScope('CHUNKS', remoteName);

      const imports = Array.from(bundles).reduce((_imports, bundleName) => {
        ports.sharedChunksRepo.tryGet(remoteName, bundleName).ifPresent(files => {
          files.forEach(file => {
            const url = _path.join(baseUrl, file);
            _imports[toChunkImport(file)] = url;
            addIntegrity(importMap, url, remoteName, file);
          });
        });
        return _imports;
      }, {} as Imports);

      if (Object.keys(imports).length > 0) addToScope(importMap, baseUrl, imports);
    });

    return importMap;
  }

  function addIntegrity(
    importMap: ImportMap,
    url: string,
    remoteName: RemoteName,
    file: string
  ): void {
    const hash = ports.remoteInfoRepo.tryGet(remoteName).get()?.integrity?.[file];
    if (!hash) return;
    if (!importMap.integrity) importMap.integrity = {};
    importMap.integrity[url] = hash;
  }

  function getScope(ctx: string, remoteName: RemoteName, externalName?: string) {
    return ports.remoteInfoRepo
      .tryGet(remoteName)
      .map(remote => remote.scopeUrl)
      .orThrow(() => {
        if (externalName) {
          config.log.error(
            4,
            `[${ctx}][${externalName}][${remoteName}] Remote name not found in cache.`
          );
        } else {
          config.log.error(4, `[${ctx}][${remoteName}] Remote name not found in cache.`);
        }

        return new NFError('Could not create ImportMap.');
      });
  }
}
