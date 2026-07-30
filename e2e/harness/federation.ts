import { test as base, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import type { ImportMap, RemoteEntry, SharedExternals } from 'lib/core/1.domain';
import { compile, startServer, MANIFEST_URL, PAGE_HOST, type Harness } from './server';
import type { BootOptions, Session } from './boot';

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
};

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
  /** Distinct builds of `pkg` the page instantiated, e.g. `['mfe-a|@angular/core@22.1.0']`. */
  buildsOf: (pkg: string) => Promise<string[]>;
  /** External files the browser really downloaded since the last init — the cost, measured. */
  downloads: () => string[];
  /** Remote entries the browser really fetched since the last init. */
  fetches: () => string[];
  /** Chunk files the browser really downloaded since the last init. */
  chunkLoads: () => string[];

  warns: () => Promise<string[]>;
  debugs: () => Promise<string[]>;
  /** `<remote> on <member>@<tag>` per incompatibility island, `<remote> mixes …` per disagreement. */
  islands: () => Promise<string[]>;
  /** Storage keys written during the last init — empty means the init decided nothing new. */
  writes: () => Promise<string[]>;
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

  // Every hostname resolves to the harness, so `http://mfe-a/` is a real origin that it serves.
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
    // Network accounting is per init, so a warm init can assert it fetched nothing.
    let mark = 0;

    const boot = async (remotes: RemoteEntry[], opts: InitOptions) => {
      const { hostEntry, unlisted, manifestFromUrl, ...bootOptions } = opts;
      shim = opts.shim ?? false;
      listed = remotes;
      mark = harness.requests.length;
      harness.serve(compile([...remotes, ...(hostEntry ? [hostEntry] : [])]));
      if (unlisted?.length) harness.add(unlisted);

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

      islands: async () =>
        (await nf.warns())
          .map(msg => {
            const gate1 = /'([^']+)' is islanded: '([^']+)' is incompatible/.exec(msg);
            if (gate1) return `${gate1[1]} on ${gate1[2]}`;
            const gate2 =
              /'([^']+)' is islanded: the builds it draws on disagree on '([^']+)' \(([^)]+)\)/.exec(
                msg
              );
            return gate2 ? `${gate2[1]} mixes ${gate2[2]} ${gate2[3]}` : undefined;
          })
          .filter((entry): entry is string => entry !== undefined)
          .sort(),

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
