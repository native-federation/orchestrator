import { createGetShared } from './get-shared';
import { createImportMapRepository } from 'lib/core/3.adapters/storage/import-map.repository';
import { createCommitChanges } from 'lib/core/2.app/steps/commit-changes';
import { createStorageHandlerMock } from 'lib/testing/handlers/storage.mock';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockExternal } from 'lib/testing/domain/externals/external.mock';
import { mockSharedVersion } from 'lib/testing/domain/externals/version.mock';
import { GLOBAL_SCOPE, type ImportMap, type SharedExternal } from 'lib/core/1.domain';

/**
 * Regression: a global external resolved during the initial init must survive a
 * later dynamic `initRemoteEntry`, whose partial map is merged (not replaced)
 * into the cache that `getShared` reads. Drives the real repo + commit-changes.
 */
describe('createGetShared after dynamic initRemoteEntry', () => {
  const NG_URL = 'https://cdn.test/host/core.js';
  const RXJS_URL = 'https://cdn.test/mfe2/rxjs.js';

  const sharedGlobal = (externals: Record<string, SharedExternal>) => {
    const ports = mockAdapters();

    // Real import-map repo so set/merge/commit behave faithfully.
    const mockStorage: Record<string, unknown> = {};
    ports.importMapRepo = createImportMapRepository({
      storage: createStorageHandlerMock(mockStorage),
      clearStorage: false,
    });

    // shared-externals repo accumulates across inits, so it knows both remotes.
    ports.sharedExternalsRepo.getScopes.mockReturnValue([GLOBAL_SCOPE]);
    ports.sharedExternalsRepo.scopeType.mockReturnValue('global');
    ports.sharedExternalsRepo.getFromScope.mockReturnValue(externals);

    return ports;
  };

  it('still bridges a global external resolved during the initial init', async () => {
    const ports = sharedGlobal({
      '@angular/core': mockExternal.shared([
        mockSharedVersion('20.0.0', '@angular/core', { remotes: ['team/host'], action: 'share' }),
      ]),
      rxjs: mockExternal.shared([
        mockSharedVersion('7.8.0', 'rxjs', { remotes: ['team/mfe2'], action: 'share' }),
      ]),
    });

    const commit = createCommitChanges(mockConfig(), ports);

    // 1. Initial init installs the full generated map (override).
    const initialMap: ImportMap = { imports: { '@angular/core': NG_URL } };
    await commit(initialMap, { override: true });

    // 2. Dynamic initRemoteEntry commits only mfe2's partial map (merged in).
    const dynamicMap: ImportMap = { imports: { rxjs: RXJS_URL } };
    await commit(dynamicMap);

    const shared = createGetShared(ports)();

    expect(shared['rxjs']).toBeDefined();
    expect(shared['@angular/core']).toBeDefined();
  });
});
