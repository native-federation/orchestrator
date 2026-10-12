import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ImportMap, RemoteEntry, SharedExternal } from 'lib/core/1.domain';
import { initFederation } from 'lib/core/init-federation';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { labelSharedInfoByNpmScope } from 'lib/testing/pooling/label-by-npm-scope';
import { emittedUrls, findIncoherentRemotes, findSplitRemotes } from 'lib/testing/pooling/no-tear';

/**
 * The recorded portfolios from `e2e/fixtures`, through the real init flow in jsdom, judged by both no-tear
 * checks. The e2e suite loads these too, but their fixtures declare no `peers`, so a browser never follows a
 * second hop there; `findSplitRemotes` follows every possible one statically.
 *
 * Also the download baseline for the pool: the distinct `@angular/*` files the map can fetch. Under the
 * gate pipeline (4.7.0) these were 37 and 75. Build election serves eleven in 54: mfe8 now runs mfe1's
 * 21.2.18 build instead of its own, and mfe2 (cdk pinned at 22.0.6) runs mfe11's 22.0.6 build.
 */
const FIXTURES = resolve(__dirname, '../../../../../../e2e/fixtures');

const SEVEN = ['mfe1', 'mfe2', 'mfe3', 'mfe4', 'mfe5', 'mfe6', 'mfe7'];
const ELEVEN = [...SEVEN, 'mfe8', 'mfe9', 'mfe10', 'mfe11'];

// The e2e harness labels by npm scope whenever pooling is on, standing in for the build-time default.
const entry = (name: string): RemoteEntry => {
  const raw = JSON.parse(readFileSync(resolve(FIXTURES, `${name}.remoteEntry.json`), 'utf8'));
  return {
    ...raw,
    url: `http://${name}/remoteEntry.json`,
    shared: labelSharedInfoByNpmScope(raw.shared ?? []),
  };
};

let namespace = 0;

async function init(names: string[]) {
  const entries = names.map(entry);
  const byUrl = new Map(entries.map(e => [e.url, e]));
  vi.stubGlobal('fetch', (url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(structuredClone(byUrl.get(url))),
    })
  );
  document.head.innerHTML = '';

  const ns = `nf-capture-${namespace++}`;
  await initFederation(Object.fromEntries(entries.map(e => [e.name, e.url])), {
    storage: globalThisStorageEntry,
    storageNamespace: ns,
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  const maps = document.head.querySelectorAll('script[type="importmap"]');
  const importMap = JSON.parse(maps[maps.length - 1]!.textContent!) as ImportMap;
  const stored = (
    globalThis as unknown as Record<
      string,
      Record<string, Record<string, Record<string, SharedExternal>>>
    >
  )[ns]!['shared-externals']!['__GLOBAL__']!;
  // Per pool: an unpooled package may legitimately self-fill across tags (the default policy), and two pools
  // are coordinated by nobody, so each is judged on its own.
  const pools = new Map<string, Record<string, SharedExternal>>();
  for (const [name, external] of Object.entries(stored)) {
    if (external.poolName === undefined) continue;
    const pool =
      pools.get(external.poolName) ?? pools.set(external.poolName, {}).get(external.poolName)!;
    pool[name] = external;
  }
  const scopeUrls = Object.fromEntries(names.map(n => [`team/${n}`, `http://${n}/`]));

  return { importMap, pools, scopeUrls };
}

const angularDownloads = (importMap: ImportMap) => {
  const angular: ImportMap = {
    imports: Object.fromEntries(
      Object.entries(importMap.imports).filter(([s]) => s.startsWith('@angular/'))
    ),
    scopes: Object.fromEntries(
      Object.entries(importMap.scopes ?? {}).map(([scope, map]) => [
        scope,
        Object.fromEntries(Object.entries(map).filter(([s]) => s.startsWith('@angular/'))),
      ])
    ),
  };
  return emittedUrls(angular).size;
};

describe('recorded portfolios (integration)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['the captured seven', SEVEN, 37],
    ['all eleven', ELEVEN, 54],
  ])(
    '%s: no remote resolves or binds a combination no build shipped',
    async (_, names, downloads) => {
      const { importMap, pools, scopeUrls } = await init(names);

      expect(pools.size).toBeGreaterThan(0);
      for (const [pool, members] of pools) {
        expect({
          pool,
          incoherent: findIncoherentRemotes({ importMap, members, scopeUrls }),
        }).toEqual({ pool, incoherent: [] });
        expect({ pool, split: findSplitRemotes({ importMap, members, scopeUrls }) }).toEqual({
          pool,
          split: [],
        });
      }
      expect(angularDownloads(importMap)).toBe(downloads);
    }
  );
});
