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

  describe('merge', () => {
    it('deep-merges imports, scopes and integrity into the cached map', () => {
      const { repo } = setup({
        imports: { '@angular/core': 'https://cdn.test/host/core.js' },
        scopes: { 'https://cdn.test/host/': { rxjs: 'https://cdn.test/host/rxjs.js' } },
        integrity: { 'https://cdn.test/host/core.js': 'sha-host' },
      });

      repo.merge({
        imports: { rxjs: 'https://cdn.test/mfe2/rxjs.js' },
        scopes: { 'https://cdn.test/mfe2/': { lib: 'https://cdn.test/mfe2/lib.js' } },
        integrity: { 'https://cdn.test/mfe2/rxjs.js': 'sha-mfe2' },
      });

      expect(repo.get()).toEqual({
        imports: {
          '@angular/core': 'https://cdn.test/host/core.js',
          rxjs: 'https://cdn.test/mfe2/rxjs.js',
        },
        scopes: {
          'https://cdn.test/host/': { rxjs: 'https://cdn.test/host/rxjs.js' },
          'https://cdn.test/mfe2/': { lib: 'https://cdn.test/mfe2/lib.js' },
        },
        integrity: {
          'https://cdn.test/host/core.js': 'sha-host',
          'https://cdn.test/mfe2/rxjs.js': 'sha-mfe2',
        },
      });
    });

    it('merges imports within an existing scope rather than replacing it', () => {
      const { repo } = setup({
        imports: {},
        scopes: { 'https://cdn.test/mfe2/': { lib: 'https://cdn.test/mfe2/lib.js' } },
      });

      repo.merge({
        imports: {},
        scopes: { 'https://cdn.test/mfe2/': { rxjs: 'https://cdn.test/mfe2/rxjs.js' } },
      });

      expect(repo.get().scopes!['https://cdn.test/mfe2/']).toEqual({
        lib: 'https://cdn.test/mfe2/lib.js',
        rxjs: 'https://cdn.test/mfe2/rxjs.js',
      });
    });

    it('does not persist until commit is called', () => {
      const { repo, mockStorage } = setup({ imports: { a: 'https://cdn.test/a.js' } });

      repo.merge({ imports: { b: 'https://cdn.test/b.js' } });

      expect(mockStorage['import-map']).toEqual({ imports: { a: 'https://cdn.test/a.js' } });

      repo.commit();
      expect(mockStorage['import-map']).toEqual({
        imports: { a: 'https://cdn.test/a.js', b: 'https://cdn.test/b.js' },
      });
    });
  });
});
