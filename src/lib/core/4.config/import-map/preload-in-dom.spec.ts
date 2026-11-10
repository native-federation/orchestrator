import { preloadInDOM } from './preload-in-dom';

describe('preloadInDOM', () => {
  const links = () => [...document.querySelectorAll('link')];

  afterEach(() => links().forEach(link => link.remove()));

  it.each(['modulepreload', 'modulepreload-shim'] as const)('appends a %s link per URL', rel => {
    preloadInDOM(rel)(['http://r0/a.js', 'http://r0/b.js']);

    expect(links().map(l => [l.rel, l.href])).toEqual([
      [rel, 'http://r0/a.js'],
      [rel, 'http://r0/b.js'],
    ]);
  });

  // es-module-shims observes document.head only, without subtree.
  it('appends to document.head', () => {
    preloadInDOM('modulepreload')(['http://r0/a.js']);

    expect(links()[0]!.parentElement).toBe(document.head);
  });

  // Each module load repeats its hint.
  it('adds one link per URL across calls', () => {
    const preload = preloadInDOM('modulepreload');

    preload(['http://r0/a.js']);
    preload(['http://r0/a.js', 'http://r0/b.js']);

    expect(links().map(l => l.href)).toEqual(['http://r0/a.js', 'http://r0/b.js']);
  });

  it('keeps no state between factories', () => {
    preloadInDOM('modulepreload')(['http://r0/a.js']);
    preloadInDOM('modulepreload')(['http://r0/a.js']);

    expect(links()).toHaveLength(2);
  });

  // A differing crossorigin makes the import fetch again; the map's integrity covers a link without one.
  it('sets neither crossorigin nor integrity', () => {
    preloadInDOM('modulepreload')(['http://r0/a.js']);

    expect(links()[0]!.hasAttribute('crossorigin')).toBe(false);
    expect(links()[0]!.hasAttribute('integrity')).toBe(false);
  });
});
