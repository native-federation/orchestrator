import { eagerPreloadUrls, type PreloadCandidate } from './eager-preloads';
import type { ImportMap } from './import-map.contract';

describe('eagerPreloadUrls', () => {
  const map = {
    imports: { lib: 'http://r1/lib.js' },
    scopes: { 'http://r2/': { own: 'http://r2/own.js' } },
  };

  const copy = (
    scopeUrl: string,
    entryFiles: string[],
    chunkFiles?: string[],
    bundleName = 'lib'
  ): PreloadCandidate => ({
    scopeUrl,
    entryFiles,
    ...(chunkFiles && { bundle: { name: bundleName, chunkFiles } }),
  });

  it('includes a served copy with its chunks, from imports and scopes', () => {
    expect(
      eagerPreloadUrls(map, [
        copy('http://r1/', ['lib.js'], ['chunk-L.js']),
        copy('http://r2/', ['own.js'], []),
      ])
    ).toEqual(['http://r1/lib.js', 'http://r1/chunk-L.js', 'http://r2/own.js']);
  });

  // r0's copy lost version resolution; its chunks would never be requested either.
  it('skips a copy the map does not serve, chunks included', () => {
    expect(eagerPreloadUrls(map, [copy('http://r0/', ['lib.js'], ['chunk-L.js'])])).toEqual([]);
  });

  // Pooling or a claim may serve some of a copy's specifiers from another copy. Its chunks are the union over
  // all its entries, so preloading them would fetch code for entries the page never runs from this copy.
  it('skips a copy the map serves only in part, chunks included', () => {
    expect(
      eagerPreloadUrls(map, [copy('http://r1/', ['lib.js', 'lib-sub.js'], ['chunk-L.js'])])
    ).toEqual([]);
  });

  it('lists each URL once', () => {
    const lib = copy('http://r1/', ['lib.js'], ['chunk-L.js']);

    expect(eagerPreloadUrls(map, [lib, lib])).toEqual(['http://r1/lib.js', 'http://r1/chunk-L.js']);
  });

  // `every` holds for no entries at all; such a copy must not bring its bundle's chunks on its own.
  it('skips a copy without entries', () => {
    expect(eagerPreloadUrls(map, [copy('http://r1/', [], ['chunk-L.js'])])).toEqual([]);
  });

  // Flat chunking (no denseChunking) stores no chunk list per bundle: docs/config.md says only entries then.
  it('preloads only the entries of a copy whose bundle has no chunk list', () => {
    expect(eagerPreloadUrls(map, [copy('http://r1/', ['lib.js'], [])])).toEqual([
      'http://r1/lib.js',
    ]);
  });

  // Two served copies of one remote built in one bundle: the bundle's chunks are listed once, after the first.
  it("adds a shared bundle's chunks once, for the first served copy", () => {
    const both = {
      imports: { a: 'http://r1/a.js', b: 'http://r1/b.js' },
    };

    expect(
      eagerPreloadUrls(both, [
        copy('http://r1/', ['a.js'], ['chunk-1.js', 'chunk-2.js'], 'shared'),
        copy('http://r1/', ['b.js'], ['chunk-1.js', 'chunk-2.js'], 'shared'),
      ])
    ).toEqual(['http://r1/a.js', 'http://r1/chunk-1.js', 'http://r1/chunk-2.js', 'http://r1/b.js']);
  });

  // The common case, nobody opted in: the map is never read, so its URL set is never built.
  it('returns nothing without reading the map when there are no candidates', () => {
    const untouchable = {
      get imports(): ImportMap['imports'] {
        throw new Error('read the map');
      },
    } as ImportMap;

    expect(eagerPreloadUrls(untouchable, [])).toEqual([]);
  });
});
