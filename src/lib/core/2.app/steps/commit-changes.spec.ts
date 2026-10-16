import { LoggingConfig } from 'lib/core/2.app/config/log.contract';
import { ForCommittingChanges } from '../driver-ports/init/for-committing-changes.port';
import { DrivingContract } from '../driving-ports/driving.contract';
import { createCommitChanges } from './commit-changes';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockConfig } from 'lib/testing/config.mock';
import { GLOBAL_SCOPE, STRICT_SCOPE } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { mockExternal_A } from 'lib/testing/domain/externals/external.mock';

describe('createCommitChanges', () => {
  let commitChanges: ForCommittingChanges;
  let config: LoggingConfig;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    commitChanges = createCommitChanges(config, adapters);
  });

  it('should persist all made changes in the repositories', async () => {
    await commitChanges({ imports: {} });

    expect(adapters.remoteInfoRepo.commit).toHaveBeenCalled();
    expect(adapters.scopedExternalsRepo.commit).toHaveBeenCalled();
    expect(adapters.sharedExternalsRepo.commit).toHaveBeenCalled();
    expect(adapters.sharedChunksRepo.commit).toHaveBeenCalled();
  });

  it('should append the importmap to the browser by default', async () => {
    await commitChanges({ imports: {} });

    expect(adapters.browser.setImportMapFn).toHaveBeenCalledWith({ imports: {} }, {});
  });

  it('should forward override to the browser so the initial map replaces stale ones', async () => {
    await commitChanges({ imports: {} }, { override: true });

    expect(adapters.browser.setImportMapFn).toHaveBeenCalledWith(
      { imports: {} },
      { override: true }
    );
  });

  // A runtime load decides no serving build; the scopes it wrote are left for the next init to decide.
  describe('markUndecided', () => {
    beforeEach(() => {
      adapters.sharedExternalsRepo = createSharedExternalsRepository({
        storage: globalThisStorageEntry('nf-commit-changes-mark'),
        clearStorage: true,
      });
      commitChanges = createCommitChanges(config, adapters);
      const repo = adapters.sharedExternalsRepo;
      repo.addOrUpdate('a', mockExternal_A()).commit();
      repo.addOrUpdate('a', mockExternal_A(), 'team');
      repo.addOrUpdate('a', mockExternal_A(), STRICT_SCOPE);
    });

    const undecided = () =>
      [GLOBAL_SCOPE, 'team', STRICT_SCOPE].filter(s => adapters.sharedExternalsRepo.isUndecided(s));

    it('marks every non-strict scope written since the last commit', async () => {
      await commitChanges({ imports: {} }, { markUndecided: true });

      expect(undecided()).toEqual(['team']);
    });

    it.each([{}, { override: true }])('marks nothing with %o', async opts => {
      await commitChanges({ imports: {} }, opts);

      expect(undecided()).toEqual([]);
    });

    it('keeps the option from the browser', async () => {
      adapters.browser.setImportMapFn = vi.fn();
      await commitChanges({ imports: {} }, { markUndecided: true });

      expect(adapters.browser.setImportMapFn).toHaveBeenCalledWith({ imports: {} }, {});
    });
  });
});
