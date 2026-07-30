import { test, expect } from '../harness/federation';
import { dep, remote, withChunks, SCOPE } from '../harness/portfolio';

/**
 * The `chunks` field of a `remoteEntry`: shared code a build split out of its externals, which the
 * external's own file imports by a bare `@nf-internal/chunk-*` specifier.
 *
 * Chunks are the one part of the map that is never global. They are mapped into the scope of the origin
 * that *serves* the file, not the remote that consumes the external — which is exactly what makes a
 * deduped external work: the consumer resolves `@angular/core` to the provider's URL, and the chunk
 * import inside that file then resolves against the provider's scope, because the importer is the file.
 *
 * The generated externals here really do import their bundle's chunks, so every assertion below is
 * about modules the browser actually fetched and evaluated.
 */
const ng = (version: string, req: string) => [
  dep('@angular/core', version, { req, bundle: 'browser-ng' }),
  dep('@angular/router', version, { req, bundle: 'browser-ng' }),
];

test('scopes a provider’s chunks to the provider, and a consumer resolves them anyway', async ({
  nf,
}) => {
  await nf.init([
    withChunks(remote('team/mfe-a', SCOPE.a, ng('18.0.0', '^18.0.0')), {
      'browser-ng': ['chunk-NG1.js', 'chunk-NG2.js'],
    }),
    remote('team/mfe-b', SCOPE.b, [dep('@angular/core', '18.0.0', { req: '^18.0.0' })]),
  ]);

  // The chunk specifiers live under mfe-a's scope only. mfe-b, which dedups mfe-a's core, gets none of
  // its own — it does not need any.
  const map = await nf.map();
  expect(map.scopes).toEqual({
    [SCOPE.a]: {
      '@nf-internal/chunk-NG1': 'http://mfe-a/chunk-NG1.js',
      '@nf-internal/chunk-NG2': 'http://mfe-a/chunk-NG2.js',
    },
  });
  expect(Object.keys(map.imports).some(key => key.startsWith('@nf-internal/'))).toBe(false);

  // And it works: loading mfe-b's module pulls mfe-a's core, which pulls mfe-a's chunks.
  expect((await nf.load('team/mfe-b')).seen['@angular/core']).toBe('mfe-a|@angular/core@18.0.0');
  expect(nf.chunkLoads()).toEqual(['http://mfe-a/chunk-NG1.js', 'http://mfe-a/chunk-NG2.js']);
});

test('gives an islanded remote its own chunk graph', async ({ nf }) => {
  // Both builds ship a bundle of the same name. The island serves its own external files, so its own
  // chunks must be mapped into its own scope — otherwise its core would resolve the shared build's
  // chunk and tear across versions inside a single package.
  await nf.init([
    withChunks(remote('team/mfe-a', SCOPE.a, ng('18.0.0', '^18.0.0')), {
      'browser-ng': ['chunk-NEW.js'],
    }),
    withChunks(remote('team/legacy', SCOPE.legacy, ng('17.0.0', '^17.0.0')), {
      'browser-ng': ['chunk-OLD.js'],
    }),
  ]);

  expect(await nf.islands()).toEqual(['team/legacy on @angular/core@17.0.0']);
  const map = await nf.map();
  expect(map.scopes?.[SCOPE.legacy]).toEqual({
    '@angular/core': 'http://legacy/@angular/core.js',
    '@angular/router': 'http://legacy/@angular/router.js',
    '@nf-internal/chunk-OLD': 'http://legacy/chunk-OLD.js',
  });
  expect(map.scopes?.[SCOPE.a]).toEqual({ '@nf-internal/chunk-NEW': 'http://mfe-a/chunk-NEW.js' });

  await nf.loadAll();
  expect(nf.chunkLoads().sort()).toEqual([
    'http://legacy/chunk-OLD.js',
    'http://mfe-a/chunk-NEW.js',
  ]);
});
