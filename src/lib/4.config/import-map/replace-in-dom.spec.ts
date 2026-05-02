import { mockImportMap } from 'lib/6.mocks/domain/import-map.mock';
import { replaceInDOM } from './replace-in-dom';
import { __resetTrustedTypesPolicyForTests } from './trusted-types';
import { ImportMap } from 'lib/1.domain';

describe('replaceInBrowser', () => {
  let config: (importMap: ImportMap, opts?: { override?: boolean }) => Promise<ImportMap>;

  beforeEach(() => {
    document.head.innerHTML = '';
    __resetTrustedTypesPolicyForTests();

    jest.spyOn(document.head, 'appendChild');
    config = replaceInDOM('custom-importmap');
  });

  afterEach(() => {
    delete (globalThis as { trustedTypes?: unknown }).trustedTypes;
    __resetTrustedTypesPolicyForTests();
  });

  it('should create a new script element with correct type', () => {
    const importMap = mockImportMap();
    config(importMap);

    const script = document.head.querySelector('script[type="custom-importmap"]');
    expect(script).not.toBeNull();
    expect(document.head.appendChild).toHaveBeenCalled();
  });

  it('should not remove existing import map scripts but append to the end by default', () => {
    const existingScript = document.createElement('script');
    existingScript.type = 'custom-importmap';
    existingScript.innerHTML = JSON.stringify({ imports: { test: 'test.js' } });
    document.head.appendChild(existingScript);

    expect(document.head.querySelectorAll('script[type="custom-importmap"]').length).toBe(1);

    const importMap = mockImportMap();
    config(importMap);

    const scripts = document.head.querySelectorAll('script[type="custom-importmap"]');
    expect(scripts.length).toBe(2);
    expect(scripts[1]!.innerHTML).toBe(JSON.stringify(importMap));
  });

  it('should remove existing import map scripts if override is true', () => {
    const existingScript = document.createElement('script');
    existingScript.type = 'custom-importmap';
    existingScript.innerHTML = JSON.stringify({ imports: { test: 'test.js' } });
    document.head.appendChild(existingScript);

    expect(document.head.querySelectorAll('script[type="custom-importmap"]').length).toBe(1);

    const importMap = mockImportMap();
    config(importMap, { override: true });

    const scripts = document.head.querySelectorAll('script[type="custom-importmap"]');
    expect(scripts.length).toBe(1);
    expect(scripts[0]!.innerHTML).toBe(JSON.stringify(importMap));
  });

  it('should set the innerHTML to stringified import map', () => {
    const importMap = mockImportMap();
    config(importMap);

    const script = document.head.querySelector('script[type="custom-importmap"]');
    expect(script!.innerHTML).toBe(JSON.stringify(importMap));
  });

  it('should return the import map', async () => {
    const importMap = mockImportMap();
    const result = await config(importMap);

    expect(result).toEqual(importMap);
  });

  it('should replace existing import map even with multiple scripts', () => {
    for (let i = 0; i < 3; i++) {
      const existingScript = document.createElement('script');
      existingScript.type = 'custom-importmap';
      existingScript.innerHTML = JSON.stringify({ imports: { [`test${i}`]: `test${i}.js` } });
      document.head.appendChild(existingScript);
    }

    expect(document.head.querySelectorAll('script[type="custom-importmap"]').length).toBe(3);

    const importMap = mockImportMap();
    config(importMap, { override: true });

    const scripts = document.head.querySelectorAll('script[type="custom-importmap"]');
    expect(scripts.length).toBe(1);
    expect(scripts[0]!.innerHTML).toBe(JSON.stringify(importMap));
  });

  it('should route the import map through a Trusted Types policy when available', () => {
    const createScript = jest.fn((s: string) => s);
    const createPolicy = jest.fn(() => ({ createScript, createScriptURL: (s: string) => s }));
    (globalThis as { trustedTypes?: unknown }).trustedTypes = { createPolicy };

    const importMap = mockImportMap();
    replaceInDOM('custom-importmap', 'my-policy')(importMap);

    expect(createPolicy).toHaveBeenCalledWith('my-policy', expect.any(Object));
    expect(createScript).toHaveBeenCalledWith(JSON.stringify(importMap));
  });

  it('should not create a policy when the policy name is false', () => {
    const createPolicy = jest.fn();
    (globalThis as { trustedTypes?: unknown }).trustedTypes = { createPolicy };

    replaceInDOM('custom-importmap', false)(mockImportMap());

    expect(createPolicy).not.toHaveBeenCalled();
  });
});
