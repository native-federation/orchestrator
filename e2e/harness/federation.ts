import { test as base, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import type { ImportMap, RemoteEntry, RemoteInfo, SharedExternals } from 'lib/core/1.domain';
import { compile, startServer, MANIFEST_URL, PAGE_HOST, type Harness } from './server';
import type { BootOptions, Session } from './boot';
import { labelSharedInfoByNpmScope } from 'lib/testing/pooling/label-by-npm-scope';
import { type GroupTear, tearsByPool } from 'lib/testing/pooling/no-tear';

/**
 * The test fixture. `nf.init` is one page load: the browser fetches the manifest and the remote
 * entries over HTTP, the library builds an import map and installs it in the document, and the
 * assertions below read that document — never an intercepted callback.
 */

const HERE = __dirname;

const bundleBoot = async () => {
  const out = await build({
    entryPoints: [resolve(HERE, 'boot.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    alias: { lib: resolve(HERE, '../../src/lib') },
  });
  return out.outputFiles[0]!.text;
};

export type InitOptions = Omit<BootOptions, 'host' | 'manifestUrl'> & {
  /**
   * Label every unlabelled scoped external with its npm scope before serving, as the build does by default
   * (see `labelSharedInfoByNpmScope`). `false` serves the entries exactly as written: explicit labels only.
   */
  pooling?: boolean;
  /** Served as the host remote entry and left out of the manifest. */
  hostEntry?: RemoteEntry;
  /** Fetchable but not listed in the manifest — the dynamic path loads these by URL. */
  unlisted?: RemoteEntry[];
  /** Hand the library a manifest URL to fetch instead of a manifest object. */
  manifestFromUrl?: boolean;
};

export type Loaded = { remote: string; seen: Record<string, string> };

export type Copy = {
  id: string;
  from: string;
  pkg: string;
  version: string;
  entrypoint: string;
  url: string;
  /** Per peer specifier this copy imports, the build it bound to. Empty unless `dep` declared `peers`. */
  boundTo: Record<string, string>;
};

export type Tear = GroupTear;

export type Federation = {
  /** Serve these entries and run a full init over a manifest containing them. One page load. */
  init: (remotes: RemoteEntry[], opts?: InitOptions) => Promise<void>;
  /** Load a remote at runtime, after the map is committed (needs `shim: true` to be observable). */
  initRemoteEntry: (url: string) => Promise<void>;

  /** The import map currently in the document; on the dynamic path, the additive delta. */
  map: () => Promise<ImportMap>;
  /** Every map the document carries, in commit order. */
  maps: () => Promise<ImportMap[]>;

  /** Load a remote's exposed module, which statically imports every entrypoint it declares. */
  load: (remoteName: string, exposedModule?: string) => Promise<Loaded>;
  /** Load every remote in the last portfolio, keyed by remote name. */
  loadAll: () => Promise<Record<string, Loaded>>;
  /** What `specifier` resolves to for code served from `scopeUrl`. */
  resolve: (specifier: string, scopeUrl: string) => Promise<string>;

  /** Externals the page actually evaluated: one entry per copy, in evaluation order. */
  copies: () => Promise<Copy[]>;
  /** Distinct builds of `pkg` the page instantiated, e.g. `['mfe1|@angular/core@22.1.0']`. */
  buildsOf: (pkg: string) => Promise<string[]>;
  /**
   * Per copy that declared `peers`, what those imports really bound to — the hop below `load()`'s
   * `seen`, which only reports a consumer's own top-level resolution.
   */
  bindings: () => Promise<Record<string, Record<string, string>>>;
  /** External files the browser really downloaded since the last init — the cost, measured. */
  downloads: () => string[];
  /** Remote entries the browser really fetched since the last init. */
  fetches: () => string[];
  /** Chunk files the browser really downloaded since the last init. */
  chunkLoads: () => string[];

  warns: () => Promise<string[]>;
  debugs: () => Promise<string[]>;
  /**
   * Every remote the stored record keeps off an elected build, read live from the last init's namespace,
   * so verdicts a later `initRemoteEntry` writes are included: `<remote> incompatible` / `<remote>
   * uncovered` per `poolCause`, `<remote> subpool <build>` per `servedBy`, which stores no cause. A
   * subpool's own build names itself and is listed too (`<build> subpool <build>`): the record cannot
   * tell a build that missed round 1 from one that only keeps its subpool for others, and both run off
   * the elected build. The warn sentences are for humans; this never parses them.
   */
  islands: () => Promise<string[]>;
  /** Storage keys written during the last init — empty means the init decided nothing new. */
  writes: () => Promise<string[]>;
  /**
   * The no-tear oracle (`lib/testing/pooling/no-tear`) per stored pool, and per npm package outside any
   * pool, run on every map the document carries and the members as stored. Only torn groups are listed:
   * `[]` is the coherent page.
   */
  tears: (namespace?: string) => Promise<Tear[]>;
  /** The committed shared-externals record, straight out of the browser's sessionStorage. */
  store: (namespace?: string) => Promise<SharedExternals>;
};

type Worker = { harness: Harness; boot: string };

/** Call one method of the in-page API. */
const call = <T>(page: Page, method: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ([m, a]) =>
      (
        globalThis as unknown as {
          __nfe2e: Record<string, (...x: unknown[]) => Promise<unknown>>;
        }
      ).__nfe2e[m as string]!(...(a as unknown[])),
    [method, args] as [string, unknown[]]
  ) as Promise<T>;

export const test = base.extend<{ nf: Federation }, Worker>({
  boot: [async ({}, use) => use(await bundleBoot()), { scope: 'worker' }],

  harness: [
    async ({ boot }, use) => {
      const harness = await startServer(boot);
      await use(harness);
      await harness.close();
    },
    { scope: 'worker' },
  ],

  // Every hostname resolves to the harness, so `http://mfe1/` is a real origin that it serves.
  browser: [
    async ({ playwright, harness }, use) => {
      const browser: Browser = await playwright.chromium.launch({
        args: [`--host-resolver-rules=MAP * 127.0.0.1:${harness.port}`],
      });
      await use(browser);
      await browser.close();
    },
    { scope: 'worker' },
  ],

  nf: async ({ page, harness }, use) => {
    harness.requests.length = 0;
    let shim = false;
    let listed: RemoteEntry[] = [];
    let storedIn = 'e2e';
    let hosts: string[] = [];
    // Network accounting is per init, so a warm init can assert it fetched nothing.
    let mark = 0;

    const boot = async (remotes: RemoteEntry[], opts: InitOptions) => {
      const { hostEntry, unlisted, manifestFromUrl, pooling = true, ...bootOptions } = opts;
      const built = (entry: RemoteEntry): RemoteEntry =>
        pooling && entry.shared
          ? { ...entry, shared: labelSharedInfoByNpmScope(entry.shared) }
          : entry;
      shim = opts.shim ?? false;
      listed = remotes;
      storedIn = opts.namespace ?? 'e2e';
      hosts = hostEntry ? [hostEntry.name] : [];
      mark = harness.requests.length;
      harness.serve(compile([...remotes, ...(hostEntry ? [hostEntry] : [])].map(built)));
      if (unlisted?.length) harness.add(unlisted.map(built));

      await page.goto(`http://${PAGE_HOST}/${shim ? '?shim=1' : ''}`);
      if (shim)
        await page.waitForFunction(
          () => typeof (globalThis as { importShim?: unknown }).importShim === 'function'
        );

      return [
        Object.fromEntries(remotes.map(r => [r.name, r.url])),
        {
          ...bootOptions,
          ...(hostEntry ? { host: hostEntry.url } : {}),
          ...(manifestFromUrl ? { manifestUrl: MANIFEST_URL } : {}),
        } satisfies BootOptions,
      ] as const;
    };

    const session = () => call<Session>(page, 'session');

    const nf: Federation = {
      init: async (remotes, opts = {}) => {
        await call(page, 'init', ...(await boot(remotes, opts)));
      },

      initRemoteEntry: async url => {
        await call(page, 'initRemoteEntry', url);
      },

      maps: () => call<ImportMap[]>(page, 'maps', shim),
      map: async () => {
        const maps = await call<ImportMap[]>(page, 'maps', shim);
        return maps[maps.length - 1]!;
      },

      load: (remoteName, exposedModule = './comp') =>
        call<Loaded>(page, 'load', remoteName, exposedModule),
      loadAll: async () => {
        const loaded: Record<string, Loaded> = {};
        for (const entry of listed)
          loaded[entry.name] = await nf.load(entry.name, entry.exposes![0]!.key);
        return loaded;
      },
      resolve: (specifier, scopeUrl) => call<string>(page, 'resolve', specifier, scopeUrl, shim),

      copies: () => call<Copy[]>(page, 'copies'),
      buildsOf: async pkg => [
        ...new Set((await nf.copies()).filter(c => c.pkg === pkg).map(c => c.id)),
      ],
      bindings: async () =>
        Object.fromEntries(
          (await nf.copies())
            .filter(copy => Object.keys(copy.boundTo ?? {}).length > 0)
            .map(copy => [copy.id, copy.boundTo])
        ),
      downloads: () =>
        harness.requests
          .slice(mark)
          .filter(r => r.kind === 'external')
          .map(r => r.url),
      fetches: () =>
        harness.requests
          .slice(mark)
          .filter(r => r.kind === 'entry')
          .map(r => r.url),
      chunkLoads: () =>
        harness.requests
          .slice(mark)
          .filter(r => r.kind === 'chunk')
          .map(r => r.url),

      warns: async () => (await session()).warns,
      debugs: async () => (await session()).debugs,
      writes: async () => (await session()).writes,

      islands: async () => {
        const islands = new Set<string>();
        for (const externals of Object.values(await nf.store(storedIn)))
          for (const external of Object.values(externals))
            for (const version of external.versions)
              for (const remote of version.remotes) {
                if (remote.poolCause) islands.add(`${remote.name} ${remote.poolCause}`);
                if (remote.servedBy) islands.add(`${remote.name} subpool ${remote.servedBy}`);
              }
        return [...islands].sort();
      },

      tears: async (namespace = storedIn) => {
        const storage = await call<Record<string, string>>(page, 'storage');
        const remotes = JSON.parse(storage[`${namespace}.remotes`] ?? '{}') as Record<
          string,
          RemoteInfo
        >;
        const scopeUrls = Object.fromEntries(
          Object.entries(remotes).map(([name, info]) => [name, info.scopeUrl])
        );
        const importMap = merge(await nf.maps());
        return tearsByPool({ importMap, externals: await nf.store(namespace), scopeUrls, hosts });
      },

      store: async (namespace = 'e2e') =>
        JSON.parse(
          (await call<Record<string, string>>(page, 'storage'))[`${namespace}.shared-externals`] ??
            '{}'
        ) as SharedExternals,
    };

    await use(nf);
  },
});

export { expect } from '@playwright/test';

// The maps a document carries, as the browser combines them: a key an earlier map set is never replaced.
const merge = (maps: ImportMap[]): ImportMap => {
  const merged: ImportMap = { imports: {}, scopes: {} };
  for (const map of maps) {
    merged.imports = { ...map.imports, ...merged.imports };
    for (const [scope, entries] of Object.entries(map.scopes ?? {}))
      merged.scopes![scope] = { ...entries, ...merged.scopes![scope] };
  }
  return merged;
};

/** Tags of every version of each member that is still globally shared, per the committed store. */
export const sharedTags = (
  store: SharedExternals,
  scope = '__GLOBAL__'
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(store[scope] ?? {}).map(([name, external]) => [
      name,
      external.versions.filter(v => v.action === 'share').map(v => v.tag),
    ])
  );

/** `tag:action` per stored version, the shape most persistence assertions want. */
export const storedActions = (
  store: SharedExternals,
  member: string,
  scope = '__GLOBAL__'
): string[] => (store[scope]?.[member]?.versions ?? []).map(v => `${v.tag}:${v.action}`);
