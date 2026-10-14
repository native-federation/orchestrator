import { createScopedExternalsRepository } from './scoped-externals.repository';
import { createStorageHandlerMock } from 'lib/testing/handlers/storage.mock';
import { StorageConfig } from 'lib/core/2.app/config';
import { mockVersion } from 'lib/testing/domain/externals/version.mock';
import { mockExternal_E, mockExternal_F } from 'lib/testing/domain/externals/external.mock';
import { ForScopedExternalsStorage } from 'lib/core/2.app/driving-ports/for-scoped-externals-storage.port';
import { Optional } from 'lib/utils/optional';
import { ScopedExternal } from 'lib/core/1.domain';

describe('createScopedExternalsRepository', () => {
  const setupWithCache = (storage: any) => {
    const mockStorage = { 'scoped-externals': storage };
    const mockStorageEntry = createStorageHandlerMock(mockStorage);

    const mockConfig: StorageConfig = {
      storage: mockStorageEntry,
      clearStorage: false,
    };
    const externalsRepo = createScopedExternalsRepository(mockConfig);
    const entry = mockStorageEntry.mock.results[0]!.value;
    return { mockStorage, externalsRepo, entry };
  };

  describe('initialization', () => {
    it('should not write to storage before a mutation is committed', () => {
      const { mockStorage, externalsRepo } = setupWithCache(undefined);

      externalsRepo.commit();

      expect(mockStorage['scoped-externals']).toBeUndefined();
      expect(externalsRepo.getAll()).toEqual({});
    });

    it('should reset cache when in config', () => {
      const mockStorage = {
        'scoped-externals': {
          ['team/mfe1']: { ...mockExternal_E(), ...mockExternal_F() },
        },
      };
      const mockStorageEntry = createStorageHandlerMock(mockStorage);
      const mockConfig: StorageConfig = {
        storage: mockStorageEntry,
        clearStorage: true,
      };
      createScopedExternalsRepository(mockConfig);
      expect(mockStorage['scoped-externals']).toEqual({});
    });
  });

  describe('addExternal', () => {
    it('should not add external to scope if no commit', () => {
      const { externalsRepo, mockStorage } = setupWithCache({
        ['team/mfe1']: {},
      });
      const newVersion = mockVersion.scoped('9.9.9', 'dep-x');

      externalsRepo.addExternal('team/mfe1', 'dep-x', newVersion);

      expect(mockStorage['scoped-externals']['team/mfe1']).toEqual({});
    });

    it('should add external to scope after commit', () => {
      const { externalsRepo, mockStorage } = setupWithCache({
        ['team/mfe1']: {},
      });
      const newVersion = mockVersion.scoped('9.9.9', 'dep-x');

      externalsRepo.addExternal('team/mfe1', 'dep-x', newVersion);

      expect(mockStorage['scoped-externals']['team/mfe1']).toEqual({});

      externalsRepo.commit();

      expect(mockStorage['scoped-externals']['team/mfe1']).toEqual({
        'dep-x': newVersion,
      });
    });

    it('should add external to a new scope', () => {
      const { externalsRepo, mockStorage } = setupWithCache({
        ['team/mfe1']: { ...mockExternal_E(), ...mockExternal_F() },
      });
      const newVersion = mockVersion.scoped('9.9.9', 'dep-x');

      externalsRepo.addExternal('new-scope', 'dep-x', newVersion);
      externalsRepo.commit();

      expect(mockStorage['scoped-externals']['new-scope']).toEqual({
        'dep-x': newVersion,
      });
    });

    it('should add multiple externals to a new scope', () => {
      const { externalsRepo, mockStorage } = setupWithCache({
        ['team/mfe1']: { ...mockExternal_E(), ...mockExternal_F() },
      });
      const newVersionA = mockVersion.scoped('8.8.8', 'dep-a');
      const newVersionB = mockVersion.scoped('9.9.9', 'dep-b');

      externalsRepo
        .addExternal('new-scope', 'dep-a', newVersionA)
        .addExternal('new-scope', 'dep-b', newVersionB);
      externalsRepo.commit();

      expect(mockStorage['scoped-externals']['new-scope']).toEqual({
        'dep-a': newVersionA,
        'dep-b': newVersionB,
      });
    });

    it('should overwrite an existing external in a scope', () => {
      const newVersion = mockVersion.scoped('8.8.8', 'new-dep-a');

      const { externalsRepo, mockStorage } = setupWithCache({
        ['team/mfe1']: { ...mockExternal_E(), ...mockExternal_F() },
      });

      externalsRepo.addExternal('team/mfe1', 'dep-a', newVersion);
      externalsRepo.commit();

      expect(mockStorage['scoped-externals']['team/mfe1']['dep-a']).toEqual(newVersion);
    });

    it('should return the repository instance for chaining', () => {
      const { externalsRepo } = setupWithCache({});
      const result = externalsRepo.addExternal(
        'scope-a',
        'dep-a',
        mockVersion.scoped('1.2.3', 'dep-a')
      );
      expect(result).toBe(externalsRepo);
    });

    it('should handle complex scoped externals setup with clean syntax', () => {
      const { externalsRepo, mockStorage } = setupWithCache({});

      externalsRepo
        .addExternal('shell-app', 'react', mockVersion.scoped('18.2.0', 'react'))
        .addExternal('shell-app', 'lodash', mockVersion.scoped('4.17.21', 'lodash'))
        .addExternal('feature-team-a', 'vue', mockVersion.scoped('3.3.4', 'vue'))
        .addExternal('feature-team-a', 'axios', mockVersion.scoped('1.4.0', 'axios'))
        .addExternal('legacy-app', 'jquery', mockVersion.scoped('3.6.0', 'jquery'));

      externalsRepo.commit();

      expect(mockStorage['scoped-externals']).toEqual({
        'shell-app': {
          react: mockVersion.scoped('18.2.0', 'react'),
          lodash: mockVersion.scoped('4.17.21', 'lodash'),
        },
        'feature-team-a': {
          vue: mockVersion.scoped('3.3.4', 'vue'),
          axios: mockVersion.scoped('1.4.0', 'axios'),
        },
        'legacy-app': {
          jquery: mockVersion.scoped('3.6.0', 'jquery'),
        },
      });
    });
  });

  describe('tryGet', () => {
    let repository: ForScopedExternalsStorage;

    beforeEach(() => {
      const { externalsRepo } = setupWithCache({
        ['team/mfe1']: {
          ...mockExternal_E(),
          ...mockExternal_F(),
        },
        ['team/mfe2']: {
          ...mockExternal_E(),
        },
      });
      repository = externalsRepo;
    });

    it('should return the externals', () => {
      const actual: Optional<ScopedExternal> = repository.tryGet('team/mfe1');
      const expected: ScopedExternal = {
        ...mockExternal_E(),
        ...mockExternal_F(),
      };

      expect(actual.isPresent()).toBe(true);
      expect(actual.get()).toEqual(expected);
    });

    it('should return empty optional if remote doesnt exist', () => {
      const { externalsRepo } = setupWithCache({});

      const actual: Optional<ScopedExternal> = externalsRepo.tryGet('team/mfe3');

      expect(actual.isPresent()).toBe(false);
      expect(actual.get()).toEqual(undefined);
    });
  });

  describe('getAll', () => {
    it('should return all externals from the cache', () => {
      const { externalsRepo } = setupWithCache({
        ['team/mfe1']: {
          'dep-a': mockVersion.scoped('1.2.3', 'dep-a'),
          'dep-b': mockVersion.scoped('1.2.3', 'dep-b'),
        },
        ['team/mfe2']: {
          'dep-x': mockVersion.scoped('1.2.3', 'dep-x'),
        },
      });

      const allExternals = externalsRepo.getAll();

      expect(allExternals).toEqual({
        ['team/mfe1']: {
          'dep-a': mockVersion.scoped('1.2.3', 'dep-a'),
          'dep-b': mockVersion.scoped('1.2.3', 'dep-b'),
        },
        ['team/mfe2']: {
          'dep-x': mockVersion.scoped('1.2.3', 'dep-x'),
        },
      });
    });
    it('should return an empty object if no externals are cached', () => {
      const { externalsRepo } = setupWithCache({});
      const allExternals = externalsRepo.getAll();
      expect(allExternals).toEqual({});
    });
  });

  describe('remove', () => {
    it('should remove a remoteEntry scope from the cache', () => {
      const { externalsRepo, mockStorage } = setupWithCache({
        ['team/mfe1']: { ...mockExternal_E(), ...mockExternal_F() },
      });

      externalsRepo.remove('team/mfe1');
      externalsRepo.commit();

      expect(mockStorage['scoped-externals']).toEqual({});
    });

    it('should not remove other remoteEntry scope', () => {
      const { externalsRepo, mockStorage } = setupWithCache({
        ['team/mfe1']: { ...mockExternal_E(), ...mockExternal_F() },
        ['team/mfe2']: { ...mockExternal_E(), ...mockExternal_F() },
      });

      externalsRepo.remove('team/mfe1');
      externalsRepo.commit();

      expect(mockStorage['scoped-externals']).toEqual({
        ['team/mfe2']: { ...mockExternal_E(), ...mockExternal_F() },
      });
    });

    it('should return the repository instance for chaining', () => {
      const { externalsRepo } = setupWithCache({});
      const result = externalsRepo.remove('scope-a');
      expect(result).toBe(externalsRepo);
    });
  });

  describe('commit', () => {
    it('should persist the cache after a mutation', () => {
      const { entry, externalsRepo } = setupWithCache({});

      externalsRepo.addExternal('team/mfe1', 'dep-x', mockVersion.scoped('9.9.9', 'dep-x'));
      externalsRepo.commit();

      expect(entry.set).toHaveBeenCalledTimes(1);
    });

    it('should not persist the cache when nothing changed', () => {
      const { entry, externalsRepo } = setupWithCache({
        ['team/mfe1']: { ...mockExternal_E() },
      });

      externalsRepo.tryGet('team/mfe1');
      externalsRepo.getAll();
      externalsRepo.commit();

      expect(entry.set).not.toHaveBeenCalled();
    });

    it('should not persist the cache when removing an unknown remote', () => {
      const { entry, externalsRepo } = setupWithCache({
        ['team/mfe1']: { ...mockExternal_E() },
      });

      externalsRepo.remove('team/mfe2');
      externalsRepo.commit();

      expect(entry.set).not.toHaveBeenCalled();
    });

    it('should not persist the cache twice without a new mutation', () => {
      const { entry, externalsRepo } = setupWithCache({});

      externalsRepo.addExternal('team/mfe1', 'dep-x', mockVersion.scoped('9.9.9', 'dep-x'));
      externalsRepo.commit();
      externalsRepo.commit();

      expect(entry.set).toHaveBeenCalledTimes(1);
    });
  });

  // A failed load hands its edits back: the cache returns to what storage last received.
  describe('rollback', () => {
    it('should restore the last commit after an uncommitted write', () => {
      const { externalsRepo } = setupWithCache({ 'team/mfe1': mockExternal_E() });
      externalsRepo.addExternal('team/mfe2', 'dep-f', mockVersion.scoped('1.2.4', 'dep-f'));
      externalsRepo.commit();

      externalsRepo.addExternal('team/mfe1', 'dep-x', mockVersion.scoped('9.9.9', 'dep-x'));
      externalsRepo.addExternal('team/mfe3', 'dep-x', mockVersion.scoped('9.9.9', 'dep-x'));
      externalsRepo.rollback();

      expect(externalsRepo.getAll()).toEqual({
        'team/mfe1': mockExternal_E(),
        'team/mfe2': { 'dep-f': mockVersion.scoped('1.2.4', 'dep-f') },
      });
    });

    it('should restore the last commit after an uncommitted remove', () => {
      const { externalsRepo } = setupWithCache({ 'team/mfe1': mockExternal_E() });

      externalsRepo.remove('team/mfe1');
      externalsRepo.rollback();

      expect(externalsRepo.tryGet('team/mfe1').get()).toEqual(mockExternal_E());
    });

    it('should fall back to an empty cache when nothing was committed', () => {
      const { externalsRepo } = setupWithCache(undefined);

      externalsRepo.addExternal('team/mfe1', 'dep-x', mockVersion.scoped('9.9.9', 'dep-x'));
      externalsRepo.rollback();

      expect(externalsRepo.getAll()).toEqual({});
    });

    it('should not persist the dropped edit on the next commit', () => {
      const { externalsRepo, entry } = setupWithCache({});

      externalsRepo.addExternal('team/mfe1', 'dep-x', mockVersion.scoped('9.9.9', 'dep-x'));
      externalsRepo.rollback();
      externalsRepo.commit();

      expect(entry.set).not.toHaveBeenCalled();
    });

    it('should persist a write made after the rollback once it is committed', () => {
      const { externalsRepo, mockStorage } = setupWithCache({});

      externalsRepo.addExternal('team/mfe1', 'dep-x', mockVersion.scoped('9.9.9', 'dep-x'));
      externalsRepo.rollback();
      externalsRepo.addExternal('team/mfe2', 'dep-f', mockVersion.scoped('1.2.4', 'dep-f'));

      expect(mockStorage['scoped-externals']).toEqual({});

      externalsRepo.commit();

      expect(mockStorage['scoped-externals']).toEqual({
        'team/mfe2': { 'dep-f': mockVersion.scoped('1.2.4', 'dep-f') },
      });
    });

    it('should return the repository instance for chaining', () => {
      const { externalsRepo } = setupWithCache({});
      expect(externalsRepo.rollback()).toBe(externalsRepo);
    });
  });
});
