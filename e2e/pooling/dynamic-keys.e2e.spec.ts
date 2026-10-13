import { test, expect, type Federation } from '../harness/federation';
import { dep, remote, shape, withChunks, HOST_NAME, SCOPE } from '../harness/portfolio';

/**
 * A remote loaded at runtime never re-declares a key the committed map already has. A browser keeps the
 * first mapping of a key (natively, and in es-module-shims without `mapOverrides`), so a re-declared key
 * would silently run the page's file instead of the loaded remote's own, against the loaded remote's other
 * files. A flat remote ships each entrypoint as its own external: the load decides the package as a whole,
 * either following the page's build for every entrypoint or running every entrypoint from its own build.
 *
 * Each case runs on native import maps and through es-module-shims with `mapOverrides` off, where an
 * override is rejected outright.
 */

const MODES = [
  { name: 'native', opts: {} },
  { name: 'shim without mapOverrides', opts: { shim: true, mapOverrides: false } },
] as const;

const flat = (entry: Parameters<typeof shape>[0]) =>
  shape(entry, { externals: 'flat', chunking: 'flat' });

// The dense host every case loads under: Angular 22 with `common/http` and `core/testing`, one chunk bundle.
const host = () =>
  withChunks(
    remote(HOST_NAME, SCOPE.host, [
      dep('@angular/core', '22.0.0', { bundle: 'ng', entrypoints: ['/testing'] }),
      dep('@angular/common', '22.0.0', { bundle: 'ng', entrypoints: ['/http'] }),
      dep('rxjs', '7.8.1', { req: '^7.4.0', entrypoints: ['/operators'] }),
    ]),
    { ng: ['chunk-HOST.js'] }
  );

const restated = async (nf: Federation) => {
  const [committed, delta] = await nf.maps();
  return Object.keys(delta!.imports).filter(key => key in committed!.imports);
};

for (const mode of MODES)
  test.describe(`a runtime load over a dense host (${mode.name})`, () => {
    for (const pooling of [false, true])
      test(`runs an incompatible flat remote's packages wholly from its own build (pooling=${pooling})`, async ({
        nf,
      }) => {
        // mfe5 is an Angular 21 build: its core and common reject the host's 22, and its rxjs matches the
        // host's tag. Each entrypoint is its own external; the load re-declares none of the host's keys.
        const mfe5 = flat(
          withChunks(
            remote('team/mfe5', SCOPE.mfe5, [
              dep('@angular/core', '21.0.0', { bundle: 'ng', entrypoints: ['/testing'] }),
              dep('@angular/common', '21.0.0', { bundle: 'ng', entrypoints: ['/http'] }),
              dep('rxjs', '7.8.1', { req: '^7.4.0', entrypoints: ['/operators'] }),
            ]),
            { ng: ['chunk-MFE5.js'] }
          )
        );
        await nf.init([], { ...mode.opts, pooling, hostEntry: host(), unlisted: [mfe5] });
        await nf.initRemoteEntry(mfe5.url);

        expect(await restated(nf)).toEqual([]);
        expect((await nf.load('team/mfe5')).seen).toEqual({
          '@angular/core': 'mfe5|@angular/core@21.0.0',
          '@angular/core/testing': 'mfe5|@angular/core/testing@21.0.0',
          '@angular/common': 'mfe5|@angular/common@21.0.0',
          '@angular/common/http': 'mfe5|@angular/common/http@21.0.0',
          rxjs: 'host.service|rxjs@7.8.1',
          'rxjs/operators': 'host.service|rxjs@7.8.1',
        });
      });

    test('follows the host wholly with a compatible flat remote', async ({ nf }) => {
      // mfe4 is a flat Angular 22 build at the host's tags: every entrypoint it ships is on the page from
      // the host's build, so it runs them all from there and downloads none of its own.
      const mfe4 = flat(
        withChunks(
          remote('team/mfe4', SCOPE.mfe4, [
            dep('@angular/core', '22.0.0', { bundle: 'ng', entrypoints: ['/testing'] }),
            dep('@angular/common', '22.0.0', { bundle: 'ng', entrypoints: ['/http'] }),
            dep('rxjs', '7.8.1', { req: '^7.4.0', entrypoints: ['/operators'] }),
          ]),
          { ng: ['chunk-MFE4.js'] }
        )
      );
      await nf.init([], { ...mode.opts, hostEntry: host(), unlisted: [mfe4] });
      await nf.initRemoteEntry(mfe4.url);

      expect(await restated(nf)).toEqual([]);
      expect((await nf.load('team/mfe4')).seen).toEqual({
        '@angular/core': 'host.service|@angular/core@22.0.0',
        '@angular/core/testing': 'host.service|@angular/core@22.0.0',
        '@angular/common': 'host.service|@angular/common@22.0.0',
        '@angular/common/http': 'host.service|@angular/common@22.0.0',
        rxjs: 'host.service|rxjs@7.8.1',
        'rxjs/operators': 'host.service|rxjs@7.8.1',
      });
      expect(nf.downloads().filter(url => url.startsWith(SCOPE.mfe4))).toEqual([]);
    });

    test('runs a strict flat remote at another major wholly from its own build', async ({ nf }) => {
      // The key collision: mfe5 ships strict core@16 and core/testing@16. Its core is scoped; its testing
      // has no share row of its own, yet the load must not map it in `imports` beside the host's.
      const mfe5 = flat(
        withChunks(
          remote('team/mfe5', SCOPE.mfe5, [
            dep('@angular/core', '16.0.0', { bundle: 'ng', entrypoints: ['/testing'] }),
          ]),
          { ng: ['chunk-MFE5.js'] }
        )
      );
      await nf.init([], { ...mode.opts, pooling: false, hostEntry: host(), unlisted: [mfe5] });
      await nf.initRemoteEntry(mfe5.url);

      expect(await restated(nf)).toEqual([]);
      expect((await nf.load('team/mfe5')).seen).toEqual({
        '@angular/core': 'mfe5|@angular/core@16.0.0',
        '@angular/core/testing': 'mfe5|@angular/core/testing@16.0.0',
      });
    });
  });
