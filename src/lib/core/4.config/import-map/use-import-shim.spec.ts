import type { Mock } from 'vitest';
import { useShimImportMap } from './use-import-shim';
import { __resetTrustedTypesPolicyForTests } from './trusted-types';

declare const global: typeof globalThis;

describe('useShimImportMap', () => {
  let importShimMock: Mock;

  beforeEach(() => {
    importShimMock = vi.fn().mockResolvedValue({});
    (global as unknown as { importShim: unknown }).importShim = importShimMock;
    __resetTrustedTypesPolicyForTests();
  });

  afterEach(() => {
    delete (globalThis as { trustedTypes?: unknown }).trustedTypes;
    delete (global as unknown as { importShim?: unknown }).importShim;
    __resetTrustedTypesPolicyForTests();
  });

  it('passes the URL string to importShim when no Trusted Types factory exists', () => {
    const config = useShimImportMap();

    config.loadModuleFn('https://example.test/a.js');

    expect(importShimMock).toHaveBeenCalledWith('https://example.test/a.js');
    expect(typeof importShimMock.mock.calls[0]![0]).toBe('string');
  });

  it('coerces a TrustedScriptURL returned by the policy to a string before calling importShim', () => {
    // Real browsers return a TrustedScriptURL object — an opaque wrapper that
    // exposes its href via toString() but has no .indexOf(). Passing it directly
    // into importShim() throws "relUrl.indexOf is not a function" inside
    // es-module-shims (see resolveIfNotPlainOrUrl).
    const trustedScriptURL = {
      toString: () => 'https://example.test/a.js',
    };
    const createScriptURL = vi.fn(() => trustedScriptURL);
    (globalThis as { trustedTypes?: unknown }).trustedTypes = {
      createPolicy: vi.fn(() => ({
        createScript: (s: string) => s,
        createScriptURL,
      })),
    };

    const config = useShimImportMap();
    config.loadModuleFn('https://example.test/a.js');

    expect(createScriptURL).toHaveBeenCalledWith('https://example.test/a.js');
    const arg = importShimMock.mock.calls[0]![0];
    expect(typeof arg).toBe('string');
    expect(arg).toBe('https://example.test/a.js');
  });

  // es-module-shims reuses only the fetches of the link type of its mode; any other is fetched twice.
  describe('preloadModulesFn', () => {
    afterEach(() => document.querySelectorAll('link').forEach(link => link.remove()));

    it.each([
      ['shim mode', { shimMode: true }, 'modulepreload-shim'],
      ['polyfill mode', { shimMode: false }, 'modulepreload'],
      ['the default', undefined, 'modulepreload'],
    ])('adds a %s link of the right type', (_name, cfg, rel) => {
      useShimImportMap(cfg).preloadModulesFn(['https://example.test/a.js']);

      expect([...document.head.querySelectorAll('link')].map(l => l.rel)).toEqual([rel]);
    });
  });
});
