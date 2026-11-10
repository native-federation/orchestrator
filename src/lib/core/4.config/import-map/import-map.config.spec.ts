import { createImportMapConfig } from './import-map.config';
import { noPreload } from './no-preload';
import type { ImportMapConfig } from 'lib/core/2.app/config/import-map.contract';
import { createBrowser } from 'lib/core/3.adapters/browser/browser';

describe('createImportMapConfig: preloadModulesFn', () => {
  const ownPreload = () => {};

  afterEach(() => document.querySelectorAll('link').forEach(link => link.remove()));

  it('defaults to the DOM preload with the default loader', () => {
    createImportMapConfig({}).preloadModulesFn!(['http://r0/a.js']);

    expect([...document.head.querySelectorAll('link')].map(l => [l.rel, l.href])).toEqual([
      ['modulepreload', 'http://r0/a.js'],
    ]);
  });

  // The DOM links would be fetches a custom loader never reuses.
  it('turns preloading off with a custom loader', () => {
    expect(createImportMapConfig({ loadModuleFn: async () => ({}) }).preloadModulesFn).toBe(
      noPreload
    );
  });

  // Documented in docs/config.md: wrapping the default loader also counts as supplying one.
  it('turns preloading off with a loader that only wraps the default one', () => {
    const { loadModuleFn: defaultLoad } = createImportMapConfig({});

    const { preloadModulesFn } = createImportMapConfig({ loadModuleFn: url => defaultLoad(url) });

    expect(preloadModulesFn).toBe(noPreload);
  });

  it.each([
    ['without a custom loader', {}],
    ['with a custom loader', { loadModuleFn: async () => ({}) }],
  ])('keeps a supplied preloadModulesFn %s', (_name, options) => {
    expect(
      createImportMapConfig({ ...options, preloadModulesFn: ownPreload }).preloadModulesFn
    ).toBe(ownPreload);
  });

  // ImportMapConfig is public in /sdk: a config written before preloading existed must still compile and
  // build a browser adapter, which then has nothing to preload with.
  it('accepts an ImportMapConfig without preloadModulesFn', () => {
    const config: ImportMapConfig = {
      loadModuleFn: async () => ({}),
      setImportMapFn: async map => map,
      reloadBrowserFn: () => {},
    };

    expect(createBrowser(config).preloadModules).toBeUndefined();
  });
});
