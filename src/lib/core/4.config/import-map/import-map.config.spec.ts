import { createImportMapConfig } from './import-map.config';
import { noPreload } from './no-preload';

describe('createImportMapConfig: preloadModulesFn', () => {
  const ownPreload = () => {};

  afterEach(() => document.querySelectorAll('link').forEach(link => link.remove()));

  it('defaults to the DOM preload with the default loader', () => {
    createImportMapConfig({}).preloadModulesFn(['http://r0/a.js']);

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
});
