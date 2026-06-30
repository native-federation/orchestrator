import { createImportMapRepository } from './import-map.repository';
import { createStorageHandlerMock } from 'lib/testing/handlers/storage.mock';
import type { ImportMap } from 'lib/core/1.domain';

describe('createImportMapRepository', () => {
  const setup = (data?: ImportMap) => {
    const mockStorage: Record<string, unknown> = { 'import-map': data };
    const mockStorageEntry = createStorageHandlerMock(mockStorage);
    const repo = createImportMapRepository({
      storage: mockStorageEntry,
      clearStorage: false,
    });
    return { mockStorage, repo };
  };

  describe('initialization', () => {
    it('seeds the entry with an empty import map', () => {
      const { mockStorage } = setup();
      expect(mockStorage['import-map']).toEqual({ imports: {} });
    });

    it('clears the entry when clearStorage is set', () => {
      const mockStorage = { 'import-map': { imports: { rxjs: 'https://cdn.test/rxjs.js' } } };
      const mockStorageEntry = createStorageHandlerMock(mockStorage);

      createImportMapRepository({ storage: mockStorageEntry, clearStorage: true });

      expect(mockStorage['import-map']).toEqual({ imports: {} });
    });
  });

  describe('get', () => {
    it('returns the cached import map', () => {
      const importMap: ImportMap = { imports: { '@angular/core': 'https://cdn.test/core.js' } };
      const { repo } = setup(importMap);
      expect(repo.get()).toEqual(importMap);
    });
  });

  describe('set / commit', () => {
    it('does not persist to storage until commit is called', () => {
      const { repo, mockStorage } = setup();
      const importMap: ImportMap = { imports: { rxjs: 'https://cdn.test/rxjs.js' } };

      repo.set(importMap);

      expect(repo.get()).toEqual(importMap);
      expect(mockStorage['import-map']).toEqual({ imports: {} });
    });

    it('persists the cached import map on commit', () => {
      const { repo, mockStorage } = setup();
      const importMap: ImportMap = {
        imports: { rxjs: 'https://cdn.test/rxjs.js' },
        scopes: { 'https://cdn.test/mfe1/': { rxjs: 'https://cdn.test/mfe1/rxjs.js' } },
      };

      repo.set(importMap).commit();

      expect(mockStorage['import-map']).toEqual(importMap);
    });
  });
});
