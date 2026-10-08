import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import {
  GLOBAL_SCOPE,
  type FederationManifest,
  type ImportMap,
  type PoolCause,
  type RemoteEntry,
  type RemoteInfo,
  type RemoteName,
  type SharedExternal,
  type SharedInfoActions,
  type shareScope,
  type SharedVersion,
} from 'lib/core/1.domain';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { Optional } from 'lib/utils/optional';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { createRemoteInfoRepository } from 'lib/core/3.adapters/storage/remote-info.repository';
import { createScopedExternalsRepository } from 'lib/core/3.adapters/storage/scoped-externals.repository';
import { createChunkRepository } from 'lib/core/3.adapters/storage/chunk.repository';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createInitDrivers } from 'lib/core/5.di/init.factory';
import { createInitFlow } from 'lib/core/2.app/flows/init.flow';
import { createInitRemoteEntryFlow } from 'lib/core/2.app/flows/init-remote-entry.flow';
import { hasPoolResults } from 'lib/core/1.domain/pooling/pool-state';
import { emittedUrls, tearsByPool } from './no-tear';
import { type CopySpec, storedRecord, version } from './portfolio-fixtures';

export type { CopySpec };

/**
 * A pooling portfolio driven through the real flows (`createInitFlow`, `createInitRemoteEntryFlow` over
 * `createInitDrivers`), so the step order is the production one: real semver, a real shared-externals
 * repository on a cleared `globalThis` namespace, remote entries served from memory instead of fetched.
 * Every init and dynamic load asserts the no-tear oracle per pool (`tearsByPool`), so a fixture cannot pass
 * while tearing a remote.
 *
 * Fixtures either `seed` stored records (builders in `portfolio-fixtures.ts`) and run `runInit()`, or hand
 * `runInit(entries)` whole remote entries. The latter needs `realRepositories`, so every repository persists
 * to the namespace and `reload` can open the next page over what this one committed.
 */

export type Island = PoolCause | `subpool ${RemoteName}`;

export type PortfolioOptions = {
  /** I3's only exemption: a host cannot be repointed onto another build. */
  hosts?: RemoteName[];
  /** The `globalThis` namespace the repositories store under. */
  storage?: string;
  /** Off for callers that judge the oracle themselves, e.g. across two maps. */
  assertNoTear?: boolean;
  /** `strict.strictExternalCompatibility`. */
  strict?: boolean;
  /**
   * Remote info, scoped externals and chunks real on the namespace too, rather than mocked off `scopeUrls`:
   * needed to init from remote entries and to `reload`.
   */
  realRepositories?: boolean;
  /**
   * The share scope `seed` writes into and every reader (`stored`, `islands`, the oracle) reads; global by
   * default. Remote entries carry their own `shareScope`.
   */
  scope?: string;
};

export type DynamicLoad = {
  actions: SharedInfoActions;
  /** The delta the load hands the browser. */
  importMap: ImportMap;
  /** The committed map with the delta added the way a browser adds it: existing keys win. */
  merged: ImportMap;
};

export const portfolio = (
  scopeUrls: Record<RemoteName, string>,
  {
    hosts = [],
    storage = 'nf-pooling-portfolio',
    assertNoTear: checkTear = true,
    strict = false,
    realRepositories = false,
    scope = GLOBAL_SCOPE,
  }: PortfolioOptions = {}
) => {
  // What the flows fetch: remote entries by URL, handed out as fresh copies the way a fetch parses them.
  const published = new Map<string, RemoteEntry>();
  let installed: ImportMap | undefined;
  let actions: SharedInfoActions | undefined;
  let writes = 0;

  // One page: fresh repositories over the namespace, cleared only for the first.
  const wire = (clearStorage: boolean) => {
    const config: ConfigContract = mockConfig();
    config.strict.strictExternalCompatibility = strict;
    const adapters: DrivingContract = mockAdapters();
    const storageConfig = { storage: globalThisStorageEntry(storage), clearStorage };
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository(storageConfig);

    if (realRepositories) {
      adapters.remoteInfoRepo = createRemoteInfoRepository(storageConfig);
      adapters.scopedExternalsRepo = createScopedExternalsRepository(storageConfig);
      adapters.sharedChunksRepo = createChunkRepository(storageConfig);
    } else {
      adapters.remoteInfoRepo.getAll = vi.fn(() => ({}));
      adapters.scopedExternalsRepo.getAll = vi.fn(() => ({}));
      adapters.sharedChunksRepo.tryGet = vi.fn(() => Optional.empty<string[]>());
      adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
        name in scopeUrls
          ? Optional.of({ scopeUrl: scopeUrls[name]!, exposes: [] } as RemoteInfo)
          : Optional.empty<RemoteInfo>()
      );
    }

    adapters.manifestProvider = {
      provide: manifest => Promise.resolve(manifest as FederationManifest),
    };
    adapters.remoteEntryProvider = {
      provide: url => {
        const entry = published.get(url.split('?')[0]!);
        return entry
          ? Promise.resolve(structuredClone(entry))
          : Promise.reject(new Error(`404 - ${url}`));
      },
    };
    // The flows end by installing their map: that is the map a test reads.
    adapters.browser = {
      setImportMapFn: importMap => Promise.resolve((installed = importMap)),
      importModule: () => Promise.resolve({}),
    };

    // Counts what this page writes; a spy installed by a caller still sees every call.
    const addOrUpdate = adapters.sharedExternalsRepo.addOrUpdate;
    adapters.sharedExternalsRepo.addOrUpdate = function (...args) {
      writes++;
      return addOrUpdate.apply(this, args);
    };

    const drivers = createInitDrivers({ config, adapters });
    // Determine reads no pool results: whatever pooling leaves dirty must carry none.
    const poolShared = drivers.poolSharedExternals;
    drivers.poolSharedExternals = () =>
      poolShared().then(() => {
        const stray: string[] = [];
        for (const s of adapters.sharedExternalsRepo.getScopes())
          for (const [name, external] of Object.entries(
            adapters.sharedExternalsRepo.getFromScope(s)
          ))
            if (external.dirty && hasPoolResults(external)) stray.push(`${s}|${name}`);
        expect(stray).toEqual([]);
      });
    // Tapped, not reordered: the dynamic flow does not return the actions it rewrote.
    const poolDynamic = drivers.poolDynamicExternals;
    drivers.poolDynamicExternals = cache =>
      poolDynamic(cache).then(result => ((actions = result.actions), result));

    // The record shape every step leaves behind, whatever it wrote: at most one row per (tag, action), newest
    // tag first. Within a tag neither the action order nor "one non-scope row" holds: pooling's
    // [share T, skip T (servedBy)] and update-cache's share beside a skip row break both by design.
    for (const key of Object.keys(drivers) as (keyof typeof drivers)[]) {
      const step = drivers[key] as (...args: unknown[]) => unknown;
      const checked = (result: unknown) => (assertRecordShape(adapters, key), result);
      (drivers as Record<string, unknown>)[key] = (...args: unknown[]) => {
        const result = step(...args);
        return result instanceof Promise ? result.then(checked) : checked(result);
      };
    }

    return { config, adapters, drivers };
  };

  let { config, adapters, drivers } = wire(true);

  // `state` is what an earlier election stored on the record, for a fixture that starts warm.
  const seed = (
    name: string,
    versions: SharedVersion[],
    dirty = true,
    state: Pick<SharedExternal, 'poolName' | 'poolWinner'> = {}
  ) =>
    adapters.sharedExternalsRepo.addOrUpdate(
      name,
      { ...storedRecord(name, versions, adapters.versionCheck.compare, dirty), ...state },
      scope
    );

  const stored = (): shareScope => adapters.sharedExternalsRepo.getFromScope(scope);

  const record = (name: string): SharedExternal => stored()[name]!;

  // With real repositories the remotes are whatever the flows stored, not the constructor's `scopeUrls`.
  const knownScopeUrls = (): Record<RemoteName, string> =>
    realRepositories
      ? Object.fromEntries(
          Object.entries(adapters.remoteInfoRepo.getAll()).map(([name, info]) => [
            name,
            info.scopeUrl,
          ])
        )
      : scopeUrls;

  const assertNoTear = (importMap: ImportMap) => {
    if (!checkTear) return;
    expect(
      tearsByPool({
        importMap,
        externals: { [scope]: stored() },
        scopeUrls: knownScopeUrls(),
        hosts,
      })
    ).toEqual([]);
  };

  // A bare specifier the map leaves unmapped fails to import, whatever the oracle says about the rest: every
  // specifier a pooled copy ships must map, in its remote's scope or in `imports`.
  const assertResolves = (importMap: ImportMap) => {
    const unresolved: string[] = [];
    for (const external of Object.values(stored())) {
      if (external.poolName === undefined) continue;
      for (const version of external.versions)
        for (const meta of version.remotes) {
          const scopeUrl = adapters.remoteInfoRepo.tryGet(meta.name).get()?.scopeUrl;
          for (const specifier of Object.keys(meta.entries)) {
            const own =
              scopeUrl === undefined ? undefined : importMap.scopes?.[scopeUrl]?.[specifier];
            if (own === undefined && importMap.imports[specifier] === undefined)
              unresolved.push(`${meta.name}|${specifier}`);
          }
        }
    }
    expect(unresolved).toEqual([]);
  };

  /**
   * The init flow, start to commit. `entries` are served as the manifest's remotes, a host among them
   * appended last as get-remote-entries appends the configured host; a remote this page already has
   * cached is skipped, as on a real warm page. Without entries it elects whatever was seeded.
   */
  const runInit = async (entries: RemoteEntry[] = []): Promise<ImportMap> => {
    if (entries.length > 0 && !realRepositories)
      throw new Error('runInit(entries) needs realRepositories.');
    for (const entry of entries) published.set(entry.url, entry);
    const host = entries.find(e => hosts.includes(e.name));
    config.hostRemoteEntry = host ? { name: host.name, url: host.url } : false;
    const manifest = Object.fromEntries(entries.filter(e => e !== host).map(e => [e.name, e.url]));

    installed = undefined;
    await createInitFlow({ flow: drivers, adapters, config })(manifest);
    const importMap = installed!;
    assertNoTear(importMap);
    assertResolves(importMap);
    return importMap;
  };

  // A warm init that re-elects every pool: each member is marked dirty first.
  const reelect = (): Promise<ImportMap> => {
    for (const [name, external] of Object.entries(stored()))
      if (external.poolName !== undefined)
        adapters.sharedExternalsRepo.addOrUpdate(name, { ...external, dirty: true }, scope);
    return runInit();
  };

  // The dynamic flow for one remote entry, fetched by URL. The committed map is generated from the record as
  // it stood before the load.
  const runDynamic = async (entry: RemoteEntry): Promise<DynamicLoad> => {
    published.set(entry.url, entry);
    const committed = await drivers.generateImportMap();
    installed = undefined;
    actions = undefined;
    await createInitRemoteEntryFlow({ flow: drivers, adapters, config })(entry.url);
    if (!installed || !actions) throw new Error(`'${entry.name}' was not loaded.`);
    const importMap: ImportMap = installed;
    const merged = addToImportMap(committed, importMap);
    assertNoTear(merged);
    assertResolves(merged);
    return { actions, importMap, merged };
  };

  // Commits this page and opens the next one over the same storage: a warm page that has refetched nothing.
  const reload = (): void => {
    if (!realRepositories) throw new Error('reload() needs realRepositories.');
    adapters.remoteInfoRepo.commit();
    adapters.scopedExternalsRepo.commit();
    adapters.sharedExternalsRepo.commit();
    adapters.sharedChunksRepo.commit();
    ({ config, adapters, drivers } = wire(false));
    writes = 0;
  };

  /**
   * Every remote pooling placed off the elected build, read off the stored record (never off the warn
   * text): its `poolCause` when it serves its own family, or `subpool <build>` when it runs a subpool's
   * build (`servedBy`), which stores no cause. Pass a pool name when a remote is placed in several pools.
   */
  const islands = (poolName?: string): Record<RemoteName, Island> => {
    const out: Record<RemoteName, Island> = {};
    for (const [name, external] of Object.entries(stored())) {
      if (poolName !== undefined && external.poolName !== poolName) continue;
      for (const v of external.versions)
        for (const copy of v.remotes) {
          const island: Island | undefined =
            copy.poolCause ?? (copy.servedBy ? `subpool ${copy.servedBy}` : undefined);
          if (island === undefined) continue;
          const seen = out[copy.name];
          if (seen !== undefined && seen !== island)
            throw new Error(
              `'${copy.name}' is placed as both '${seen}' and '${island}' (at '${name}'); pass a pool name.`
            );
          out[copy.name] = island;
        }
    }
    return out;
  };

  // Distinct files the map can make a browser fetch: the static stand-in for the e2e download count.
  const downloads = (importMap: ImportMap): number => emittedUrls(importMap).size;

  return {
    get config() {
      return config;
    },
    get adapters() {
      return adapters;
    },
    /** The composed drivers, for a caller that must run one step in isolation. */
    get drivers() {
      return drivers;
    },
    /** Shared-externals writes since this page opened. */
    writes: () => writes,
    reload,
    version,
    seed,
    stored,
    record,
    scopeUrls: knownScopeUrls,
    runInit,
    reelect,
    runDynamic,
    islands,
    downloads,
  };
};

const assertRecordShape = (adapters: DrivingContract, step: string): void => {
  const misshapen: string[] = [];
  const { sharedExternalsRepo: repo, versionCheck } = adapters;
  for (const scope of repo.getScopes())
    for (const [name, external] of Object.entries(repo.getFromScope(scope))) {
      const keys = external.versions.map(v => `${v.tag}|${v.action}`);
      const duplicated = keys.some((key, i) => keys.indexOf(key) !== i);
      const unordered = external.versions.some(
        (v, i) => i > 0 && versionCheck.compare(external.versions[i - 1]!.tag, v.tag) < 0
      );
      if (duplicated || unordered) misshapen.push(`${step}: ${scope}|${name} [${keys.join(', ')}]`);
    }
  expect(misshapen).toEqual([]);
};

// Import maps are immutable once set: a later map only adds keys the committed one lacks.
const addToImportMap = (committed: ImportMap, delta: ImportMap): ImportMap => {
  const scopes: Record<string, Record<string, string>> = {};
  for (const map of [delta, committed])
    for (const [scope, imports] of Object.entries(map.scopes ?? {}))
      scopes[scope] = { ...scopes[scope], ...imports };
  return { imports: { ...delta.imports, ...committed.imports }, scopes };
};
