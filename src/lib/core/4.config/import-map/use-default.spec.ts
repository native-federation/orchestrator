import { useDefaultImportMap } from './use-default';

describe('useDefaultImportMap: preloadModulesFn', () => {
  afterEach(() => document.querySelectorAll('link').forEach(link => link.remove()));

  // A modulepreload-shim link would be a fetch the native loader never reuses.
  it('adds a native modulepreload link', () => {
    useDefaultImportMap().preloadModulesFn(['https://example.test/a.js']);

    expect([...document.head.querySelectorAll('link')].map(l => [l.rel, l.href])).toEqual([
      ['modulepreload', 'https://example.test/a.js'],
    ]);
  });
});
