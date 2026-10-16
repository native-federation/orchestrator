import { GLOBAL_SCOPE, STRICT_SCOPE } from 'lib/core/1.domain';
import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { mockExternal_A } from 'lib/testing/domain/externals/external.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import type { DrivingContract } from '../driving-ports/driving.contract';
import { createMarkUndecidedScopes } from './mark-undecided-scopes';

describe('createMarkUndecidedScopes', () => {
  let adapters: DrivingContract;

  beforeEach(() => {
    adapters = mockAdapters();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-mark-undecided-scopes'),
      clearStorage: true,
    });
  });

  const importMap: ImportMap = { imports: { a: 'http://r1/a.js' } };
  const mark = () => createMarkUndecidedScopes(adapters)(importMap);
  const undecided = (...scopes: string[]) =>
    scopes.filter(s => adapters.sharedExternalsRepo.isUndecided(s));

  it('marks every scope written since the last commit and passes the map on', async () => {
    adapters.sharedExternalsRepo.addOrUpdate('a', mockExternal_A());
    adapters.sharedExternalsRepo.addOrUpdate('a', mockExternal_A(), 'team');

    await expect(mark()).resolves.toBe(importMap);

    expect(undecided(GLOBAL_SCOPE, 'team')).toEqual([GLOBAL_SCOPE, 'team']);
  });

  it('marks no scope that was written only before the last commit', async () => {
    adapters.sharedExternalsRepo.addOrUpdate('a', mockExternal_A(), 'team').commit();
    adapters.sharedExternalsRepo.addOrUpdate('a', mockExternal_A());

    await mark();

    expect(undecided(GLOBAL_SCOPE, 'team')).toEqual([GLOBAL_SCOPE]);
  });

  // The strict scope has no serving build, so nothing would ever unmark it.
  it('never marks the strict scope', async () => {
    adapters.sharedExternalsRepo.addOrUpdate('a', mockExternal_A(), STRICT_SCOPE);

    await mark();

    expect(undecided(STRICT_SCOPE)).toEqual([]);
  });
});
