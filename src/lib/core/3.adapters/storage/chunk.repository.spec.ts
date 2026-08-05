import { createStorageHandlerMock } from 'lib/testing/handlers/storage.mock';
import { StorageConfig } from 'lib/core/2.app/config';
import { createChunkRepository } from './chunk.repository';
import { Optional } from 'lib/utils/optional';
import { ChunkInfo } from '@softarc/native-federation/domain';

describe('createChunkRepository', () => {
  const setupWithCache = (storage: any) => {
    const mockStorage = { 'shared-chunks': storage };
    const mockStorageEntry = createStorageHandlerMock(mockStorage);

    const mockConfig: StorageConfig = {
      storage: mockStorageEntry,
      clearStorage: false,
    };
    const chunksRepo = createChunkRepository(mockConfig);
    const entry = mockStorageEntry.mock.results[0]!.value;
    return { mockStorage, chunksRepo, entry };
  };

  describe('initialization', () => {
    it('should not write to storage before a mutation is committed', () => {
      const { mockStorage, chunksRepo } = setupWithCache(undefined);

      chunksRepo.commit();

      expect(mockStorage['shared-chunks']).toBeUndefined();
      expect(chunksRepo.tryGet('team/mfe1', 'shared-browser').isPresent()).toBe(false);
    });

    it('should reset cache when in config', () => {
      const mockStorage = {
        'shared-chunks': {
          ['team/mfe1']: ['chunk-ABC.js', 'chunk-DEF.js'],
        },
      };
      const mockStorageEntry = createStorageHandlerMock(mockStorage);
      const mockConfig: StorageConfig = {
        storage: mockStorageEntry,
        clearStorage: true,
      };
      createChunkRepository(mockConfig);
      expect(mockStorage['shared-chunks']).toEqual({});
    });
  });

  describe('addOrReplace', () => {
    it('should not add chunks if no commit', () => {
      const { chunksRepo, mockStorage } = setupWithCache({});

      chunksRepo.addOrReplace('team/mfe1', 'shared-browser', ['chunk-ABC.js', 'chunk-DEF.js']);

      expect(mockStorage['shared-chunks']).toEqual({});
    });

    it('should add chunks to storage after commit', () => {
      const { chunksRepo, mockStorage } = setupWithCache({});

      chunksRepo.addOrReplace('team/mfe1', 'shared-browser', ['chunk-ABC.js', 'chunk-DEF.js']);

      expect(mockStorage['shared-chunks']).toEqual({});

      chunksRepo.commit();

      expect(mockStorage['shared-chunks']).toEqual({
        'team/mfe1': {
          'shared-browser': ['chunk-ABC.js', 'chunk-DEF.js'],
        },
      });
    });

    it('should add chunks to the same remote', () => {
      const { chunksRepo, mockStorage } = setupWithCache({
        'team/mfe1': {
          'shared-browser': ['chunk-ABC.js'],
        },
      });

      chunksRepo.addOrReplace('team/mfe1', 'different-build', ['chunk-DEF.js']);

      chunksRepo.commit();

      expect(mockStorage['shared-chunks']).toEqual({
        'team/mfe1': {
          'shared-browser': ['chunk-ABC.js'],
          'different-build': ['chunk-DEF.js'],
        },
      });
    });

    it('should add scope to a new remote', () => {
      const { chunksRepo, mockStorage } = setupWithCache({
        'team/mfe1': {
          'shared-browser': ['chunk-ABC.js'],
        },
      });

      chunksRepo.addOrReplace('team/mfe2', 'shared-browser', ['chunk-DEF.js']);

      chunksRepo.commit();

      expect(mockStorage['shared-chunks']).toEqual({
        'team/mfe1': {
          'shared-browser': ['chunk-ABC.js'],
        },
        'team/mfe2': {
          'shared-browser': ['chunk-DEF.js'],
        },
      });
    });

    it('should overwrite an existing build in a remote', () => {
      const { chunksRepo, mockStorage } = setupWithCache({
        'team/mfe1': {
          'shared-browser': ['chunk-ABC.js'],
        },
      });

      chunksRepo.addOrReplace('team/mfe1', 'shared-browser', ['chunk-DEF.js']);

      chunksRepo.commit();

      expect(mockStorage['shared-chunks']).toEqual({
        'team/mfe1': {
          'shared-browser': ['chunk-DEF.js'],
        },
      });
    });

    it('should return the repository instance for chaining', () => {
      const { chunksRepo } = setupWithCache({
        'team/mfe1': {
          'shared-browser': ['chunk-ABC.js'],
        },
      });

      const result = chunksRepo.addOrReplace('team/mfe1', 'shared-browser', ['chunk-DEF.js']);

      expect(result).toBe(chunksRepo);
    });
  });

  describe('remove', () => {
    // The whole remote goes, not just the bundles the replacement entry redeclares: a rebuild that
    // stops chunking a bundle omits its key, so `addOrReplace` alone can never clear it.
    it('should drop every bundle of the remote', () => {
      const { chunksRepo, mockStorage } = setupWithCache({
        'team/mfe1': {
          'shared-browser': ['chunk-ABC.js'],
          'mapping-or-exposed': ['chunk-DEF.js'],
        },
        'team/mfe2': { 'shared-browser': ['chunk-GHI.js'] },
      });

      chunksRepo.remove('team/mfe1');
      chunksRepo.commit();

      expect(mockStorage['shared-chunks']).toEqual({
        'team/mfe2': { 'shared-browser': ['chunk-GHI.js'] },
      });
    });

    it('should not persist anything when the remote has no chunks', () => {
      const { entry, chunksRepo } = setupWithCache({
        'team/mfe1': { 'shared-browser': ['chunk-ABC.js'] },
      });

      chunksRepo.remove('team/mfe2');
      chunksRepo.commit();

      expect(entry.set).not.toHaveBeenCalled();
    });

    it('should return the repository instance for chaining', () => {
      const { chunksRepo } = setupWithCache({});

      expect(chunksRepo.remove('team/mfe1')).toBe(chunksRepo);
    });
  });

  describe('commit', () => {
    it('should persist the cache after a mutation', () => {
      const { entry, chunksRepo } = setupWithCache({});

      chunksRepo.addOrReplace('team/mfe1', 'shared-browser', ['chunk-ABC.js']);
      chunksRepo.commit();

      expect(entry.set).toHaveBeenCalledTimes(1);
    });

    it('should not persist the cache when nothing changed', () => {
      const { entry, chunksRepo } = setupWithCache({
        'team/mfe1': { 'shared-browser': ['chunk-ABC.js'] },
      });

      chunksRepo.tryGet('team/mfe1', 'shared-browser');
      chunksRepo.commit();

      expect(entry.set).not.toHaveBeenCalled();
    });

    it('should not persist the cache twice without a new mutation', () => {
      const { entry, chunksRepo } = setupWithCache({});

      chunksRepo.addOrReplace('team/mfe1', 'shared-browser', ['chunk-ABC.js']);
      chunksRepo.commit();
      chunksRepo.commit();

      expect(entry.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('tryGet', () => {
    it('should return the chunk files', () => {
      const { chunksRepo } = setupWithCache({
        'team/mfe1': {
          'shared-browser': ['chunk-ABC.js'],
        },
      });

      const actual: Optional<string[]> = chunksRepo.tryGet('team/mfe1', 'shared-browser');

      expect(actual.isPresent()).toBe(true);
      expect(actual.get()).toEqual(['chunk-ABC.js']);
    });

    it('should return an empty optional if the remote is not registered.', () => {
      const { chunksRepo } = setupWithCache({});

      const actual: Optional<string[]> = chunksRepo.tryGet('team/mfe1', 'shared-browser');

      expect(actual.isPresent()).toBe(false);
    });
  });
});
