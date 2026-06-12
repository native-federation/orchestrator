import type { Mock } from 'vitest';
import { createBrowser } from './browser';
import { ImportMapConfig } from 'lib/core/2.app/config/import-map.contract';
import { ForBrowserTasks } from 'lib/core/2.app/driving-ports/for-browser-tasks';

function setupDomEnvironment() {
  document.head.innerHTML = '';

  vi.spyOn(document.head, 'appendChild');
}

describe('createBrowser', () => {
  let browser: ForBrowserTasks;
  let mockConfig: ImportMapConfig;
  let mockLoadModuleFn: Mock;
  let mockSetImportMap: Mock;

  beforeEach(() => {
    setupDomEnvironment();

    mockLoadModuleFn = vi.fn().mockImplementation(_ => {
      return Promise.resolve({ default: { name: 'mocked-module' } });
    });

    mockSetImportMap = vi.fn((importMap: ImportMap) => {
      return Promise.resolve(importMap);
    });

    mockConfig = {
      loadModuleFn: mockLoadModuleFn,
      setImportMapFn: mockSetImportMap,
      reloadBrowserFn: vi.fn(),
    };

    browser = createBrowser(mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('importModule', () => {
    it('should call the loadModuleFn with the provided URL', async () => {
      const moduleUrl = 'https://example.com/module.js';

      await browser.importModule(moduleUrl);

      expect(mockLoadModuleFn).toHaveBeenCalledWith(moduleUrl);
    });

    it('should return the result from loadModuleFn', async () => {
      const moduleUrl = 'https://example.com/module.js';
      const expectedModule = { default: { name: 'mocked-module' } };

      const result = await browser.importModule(moduleUrl);

      expect(result).toEqual(expectedModule);
    });

    it('should propagate errors from loadModuleFn', async () => {
      const moduleUrl = 'https://example.com/error-module.js';
      const expectedError = new Error('Failed to load module');

      mockLoadModuleFn.mockRejectedValueOnce(expectedError);

      await expect(browser.importModule(moduleUrl)).rejects.toThrow(expectedError);
    });
  });

  describe('setImportMapFn', () => {
    it('should call the setImportMapFn with the provided import map', async () => {
      const importMap = { imports: { 'mocked-module': 'https://example.com/mocked-module.js' } };

      await browser.setImportMapFn(importMap);

      expect(mockSetImportMap).toHaveBeenCalledWith(importMap);
    });

    it('should return the result from setImportMapFn', async () => {
      const importMap = { imports: { 'mocked-module': 'https://example.com/mocked-module.js' } };

      const result = await browser.setImportMapFn(importMap);

      expect(result).toEqual(importMap);
    });

    it('should propagate errors from setImportMapFn', async () => {
      const importMap = { imports: { 'mocked-module': 'https://example.com/mocked-module.js' } };
      const expectedError = new Error('Failed to set import map');

      mockSetImportMap.mockRejectedValueOnce(expectedError);

      await expect(browser.setImportMapFn(importMap)).rejects.toThrow(expectedError);
    });
  });
});
