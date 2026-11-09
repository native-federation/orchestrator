import { eagerPreloadUrls } from './eager-preloads';

describe('eagerPreloadUrls', () => {
  const map = {
    imports: { lib: 'http://r1/lib.js' },
    scopes: { 'http://r2/': { own: 'http://r2/own.js' } },
  };

  it('includes a served copy with its chunks, from imports and scopes', () => {
    expect(
      eagerPreloadUrls(map, [
        { entryUrls: ['http://r1/lib.js'], chunkUrls: ['http://r1/chunk-L.js'] },
        { entryUrls: ['http://r2/own.js'], chunkUrls: [] },
      ])
    ).toEqual(['http://r1/lib.js', 'http://r1/chunk-L.js', 'http://r2/own.js']);
  });

  // r0's copy lost version resolution; its chunks would never be requested either.
  it('skips a copy the map does not serve, chunks included', () => {
    expect(
      eagerPreloadUrls(map, [
        { entryUrls: ['http://r0/lib.js'], chunkUrls: ['http://r0/chunk-L.js'] },
      ])
    ).toEqual([]);
  });

  // Pooling or a claim may serve some of a copy's specifiers from another copy. Its chunks are the union over
  // all its entries, so preloading them would fetch code for entries the page never runs from this copy.
  it('skips a copy the map serves only in part, chunks included', () => {
    expect(
      eagerPreloadUrls(map, [
        {
          entryUrls: ['http://r1/lib.js', 'http://r1/lib-sub.js'],
          chunkUrls: ['http://r1/chunk-L.js'],
        },
      ])
    ).toEqual([]);
  });

  it('lists each URL once', () => {
    const copy = { entryUrls: ['http://r1/lib.js'], chunkUrls: ['http://r1/chunk-L.js'] };

    expect(eagerPreloadUrls(map, [copy, copy])).toEqual([
      'http://r1/lib.js',
      'http://r1/chunk-L.js',
    ]);
  });
});
