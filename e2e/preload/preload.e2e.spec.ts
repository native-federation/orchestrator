import { test, expect, type Federation } from '../harness/federation';
import { dep, remote, withChunks, SCOPE, EXPOSED } from '../harness/portfolio';
import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';

/**
 * Preloading in a real browser: what the library hands `preloadInDOM`, checked against what the browser then
 * requests. A preload pays off only when its URL is byte-identical to the one the import map resolves, so
 * every assertion below is about requests: each preloaded file is downloaded once, never twice, and a file
 * of a copy the map does not serve is never downloaded at all.
 */

// An exposed module importing two chunks of its own, as a build lists them in `exposes[].chunks`.
const withExposedChunks = (entry: RemoteEntry, chunks: string[]): RemoteEntry => ({
  ...entry,
  exposes: entry.exposes.map(exposed => ({ ...exposed, chunks })),
});

// A shared copy that opted into preloading; its chunks are the bundle's, as core lists them for it.
const preloaded = (shared: DenseSharedInfo, chunks: string[]): DenseSharedInfo =>
  Object.assign(shared, { preload: true as const, chunks });

const count = (nf: Federation, url: string) => nf.requests().filter(u => u === url).length;

for (const shim of [false, true]) {
  const rel = shim ? 'modulepreload-shim' : 'modulepreload';

  test.describe(`preloading (${shim ? 'es-module-shims, shim mode' : 'native import maps'})`, () => {
    test("loadRemoteModule preloads the module's chunks, each downloaded once", async ({ nf }) => {
      const chunks = ['comp-a.js', 'comp-b.js'];
      await nf.init(
        [withExposedChunks(remote('team/mfe1', SCOPE.mfe1, [dep('rxjs', '7.8.0')]), chunks)],
        {
          shim,
        }
      );

      await nf.load('team/mfe1', EXPOSED);

      const links = await nf.links();
      expect(links.map(l => l.href)).toEqual(chunks.map(c => `${SCOPE.mfe1}${c}`));
      for (const link of links) {
        expect(link).toMatchObject({ rel, head: true, afterMap: true });
        expect(count(nf, link.href)).toBe(1);
      }
    });

    // On hover the import has not started yet, so the module itself is preloaded too.
    test('preloadRemoteModule preloads the module and its chunks ahead of the load', async ({
      nf,
    }) => {
      const chunks = ['comp-a.js'];
      await nf.init(
        [withExposedChunks(remote('team/mfe1', SCOPE.mfe1, [dep('rxjs', '7.8.0')]), chunks)],
        {
          shim,
        }
      );

      await nf.preload('team/mfe1', EXPOSED);
      const urls = [`${SCOPE.mfe1}comp.js`, `${SCOPE.mfe1}comp-a.js`];
      expect((await nf.links()).map(l => l.href)).toEqual(urls);

      await nf.load('team/mfe1', EXPOSED);
      for (const url of urls) expect(count(nf, url)).toBe(1);
    });

    test('preloadRemoteModule does nothing for a module it cannot find', async ({ nf }) => {
      await nf.init([remote('team/mfe1', SCOPE.mfe1, [dep('rxjs', '7.8.0')])], { shim });

      await nf.preload('team/mfe1', './missing');
      await nf.preload('team/unknown', EXPOSED);

      expect(await nf.links()).toEqual([]);
    });

    // mfe2 ships the newer copy, so its files serve both remotes and mfe1's never reach the map.
    test('preloads the served copy that opted in, after its map', async ({ nf }) => {
      const lib = preloaded(dep('lib', '1.1.0', { bundle: 'lib' }), ['lib-chunk.js']);
      await nf.init(
        [
          remote('team/mfe1', SCOPE.mfe1, [dep('lib', '1.0.0', { req: '^1.0.0' })]),
          withChunks(remote('team/mfe2', SCOPE.mfe2, [lib]), { lib: ['lib-chunk.js'] }),
        ],
        { shim }
      );

      const served = [`${SCOPE.mfe2}lib.js`, `${SCOPE.mfe2}lib-chunk.js`];
      await expect.poll(async () => (await nf.links()).map(l => l.href)).toEqual(served);
      for (const link of await nf.links())
        expect(link).toMatchObject({ rel, head: true, afterMap: true });

      await nf.load('team/mfe1', EXPOSED);
      for (const url of served) expect(count(nf, url)).toBe(1);
      expect(count(nf, `${SCOPE.mfe1}lib.js`)).toBe(0);
    });

    test('ignores the flag on a copy that lost version resolution', async ({ nf }) => {
      const lost = preloaded(dep('lib', '1.0.0', { req: '^1.0.0', bundle: 'lib' }), [
        'lib-chunk.js',
      ]);
      await nf.init(
        [
          withChunks(remote('team/mfe1', SCOPE.mfe1, [lost]), { lib: ['lib-chunk.js'] }),
          remote('team/mfe2', SCOPE.mfe2, [dep('lib', '1.1.0')]),
        ],
        { shim }
      );

      await nf.load('team/mfe1', EXPOSED);

      expect(await nf.links()).toEqual([]);
      expect(count(nf, `${SCOPE.mfe1}lib.js`)).toBe(0);
      expect(count(nf, `${SCOPE.mfe1}lib-chunk.js`)).toBe(0);
    });
  });
}

/**
 * Chromium fixes a file's import resolutions when it preloads the file, so a later map can no longer change
 * them (it can for a file nothing has fetched yet). An eager preload is still safe on the dynamic path,
 * because a later map only adds: scopes under the new remote's own URL, and global names nobody served yet.
 * The preloaded copy's own imports were all mapped by the map it was preloaded under.
 */
test.describe('preloading and a later import map (native)', () => {
  test('keeps an eagerly preloaded copy on the build the committed map gave it', async ({ nf }) => {
    const lib = preloaded(dep('lib', '1.0.0', { peers: ['rxjs'] }), []);
    const late = remote('team/mfe3', SCOPE.mfe3, [
      dep('rxjs', '6.0.0', { req: '^6.0.0' }),
      dep('forms', '1.0.0'),
    ]);
    await nf.init([remote('team/mfe1', SCOPE.mfe1, [lib, dep('rxjs', '7.8.0')])], {
      unlisted: [late],
    });
    await expect
      .poll(async () => (await nf.links()).map(l => l.href))
      .toEqual([`${SCOPE.mfe1}lib.js`]);

    await nf.initRemoteEntry(late.url);

    expect((await nf.load('team/mfe1', EXPOSED)).seen['lib']).toBe('mfe1|lib@1.0.0');
    expect(await nf.bindings()).toEqual({ 'mfe1|lib@1.0.0': { rxjs: 'mfe1|rxjs@7.8.0' } });
    expect((await nf.load('team/mfe3', EXPOSED)).seen).toEqual({
      rxjs: 'mfe3|rxjs@6.0.0',
      forms: 'mfe3|forms@1.0.0',
    });
    expect(count(nf, `${SCOPE.mfe1}lib.js`)).toBe(1);
  });
});
