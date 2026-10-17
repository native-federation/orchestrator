import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { DrivingContract } from '../driving-ports/driving.contract';
import { LoggingConfig } from '../config/log.contract';
import { Optional } from 'lib/utils/optional';
import { ForUpdatingCache } from 'lib/core/2.app/driver-ports/init/for-updating-cache';
import { createUpdateCache } from './update-cache';
import { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { RemoteInfo, SharedExternal } from 'lib/core/1.domain';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { readScopeThroughTryGet } from 'lib/testing/adapters/shared-externals.repository.mock';
import {
  mockRemoteInfo_MFE1,
  mockRemoteInfo_MFE2,
} from 'lib/testing/domain/remote-info/remote-info.mock';
import { mockExternal } from 'lib/testing/domain/externals/external.mock';
import {
  mockVersion,
  mockVersion_A,
  mockVersion_B,
} from 'lib/testing/domain/externals/version.mock';
import { mockRemoteEntry_MFE1 } from 'lib/testing/domain/remote-entry/remote-entry.mock';
import {
  mockSharedInfo,
  mockSharedInfoA,
  mockSharedInfoB,
} from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockScopeUrl_MFE2 } from 'lib/testing/domain/scope-url.mock';

describe('createProcessDynamicRemoteEntry - scoped', () => {
  let updateCache: ForUpdatingCache;
  let config: LoggingConfig & ModeConfig;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();

    adapters.versionCheck.isValidSemver = vi.fn(() => true);
    adapters.versionCheck.compare = vi.fn(() => 0);

    adapters.remoteInfoRepo.tryGet = vi.fn(remote => {
      if (remote === 'team/mfe2') return Optional.of(mockRemoteInfo_MFE2({ exposes: [] }));
      if (remote === 'team/mfe1') return Optional.of(mockRemoteInfo_MFE1({ exposes: [] }));
      return Optional.empty<RemoteInfo>();
    });

    adapters.sharedExternalsRepo.tryGet = vi.fn(_e => Optional.empty<SharedExternal>());
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'shareScope');

    updateCache = readScopeThroughTryGet(
      adapters.sharedExternalsRepo,
      createUpdateCache(config, adapters)
    );
  });

  it('should add version as "skip" if shared compatible version exists', async () => {
    adapters.versionCheck.isCompatible = vi.fn(() => true);

    adapters.sharedExternalsRepo.tryGet = vi.fn((): Optional<SharedExternal> =>
      Optional.of(
        mockExternal.shared(
          [mockVersion_A.v2_1_2({ remotes: { 'team/mfe2': { cached: true } }, action: 'share' })],
          { dirty: false }
        )
      )
    );

    const remoteEntry = mockRemoteEntry_MFE1({
      shared: [mockSharedInfoA.v2_1_1({ shareScope: 'custom-scope' })],
      exposes: [],
    });

    const actual = await updateCache(remoteEntry);

    expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledTimes(1);
    expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
      'dep-a',
      mockExternal.shared(
        [
          mockVersion_A.v2_1_2({ remotes: { 'team/mfe2': { cached: true } }, action: 'share' }),
          mockVersion_A.v2_1_1({ remotes: { 'team/mfe1': { cached: false } }, action: 'skip' }),
        ],
        { dirty: false }
      ),
      'custom-scope'
    );

    expect(actual.actions).toEqual({
      'dep-a': {
        action: 'skip',
        covered: ['dep-a'],
        override: { 'dep-a': mockScopeUrl_MFE2({ file: 'dep-a.js' }) },
      },
    });
  });

  // The override maps every entrypoint the followed build serves of the package, as init maps a skip copy's
  // serving version; `covered` lists the remote's own.
  it('should build a multi-entry override map from the provider entries', async () => {
    adapters.versionCheck.isCompatible = vi.fn(() => true);

    adapters.sharedExternalsRepo.tryGet = vi.fn((): Optional<SharedExternal> =>
      Optional.of(
        mockExternal.shared(
          [
            mockVersion_A.v2_1_2({
              remotes: {
                'team/mfe2': {
                  cached: true,
                  entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' },
                },
              },
              action: 'share',
            }),
          ],
          { dirty: false }
        )
      )
    );

    const remoteEntry = mockRemoteEntry_MFE1({
      shared: [mockSharedInfoA.v2_1_1({ shareScope: 'custom-scope' })],
      exposes: [],
    });

    const actual = await updateCache(remoteEntry);

    expect(actual.actions).toEqual({
      'dep-a': {
        action: 'skip',
        covered: ['dep-a'],
        override: {
          'dep-a': mockScopeUrl_MFE2({ file: 'dep-a.js' }),
          'dep-a/sub': mockScopeUrl_MFE2({ file: 'dep-a-sub.js' }),
        },
      },
    });
  });

  // `mfe3` is a copy of the shared version that pooling placed in `team/mfe9`'s subpool, so the committed
  // map already points mfe3's own scope at mfe9's files: `dep-a/sub` is served to nobody else. The joiner
  // cannot take the map's `dep-a` beside its own `/sub`, so it runs the package from its own build;
  // `poolDynamicExternals` is what redirects it to that subpool's build when the joiner is pooled too.
  it('should scope a remote whose entrypoint only a subpool copy declares', async () => {
    adapters.versionCheck.isCompatible = vi.fn(() => true);

    adapters.sharedExternalsRepo.tryGet = vi.fn((): Optional<SharedExternal> =>
      Optional.of(
        mockExternal.shared(
          [
            mockVersion_A.v2_1_2({
              remotes: {
                'team/mfe2': { cached: true, entries: { 'dep-a': 'dep-a.js' } },
                'team/mfe3': {
                  servedBy: 'team/mfe9',
                  entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' },
                },
              },
              action: 'share',
            }),
          ],
          { dirty: false }
        )
      )
    );

    const remoteEntry = mockRemoteEntry_MFE1({
      shared: [
        mockSharedInfoA.v2_1_1({
          shareScope: 'custom-scope',
          entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' },
        }),
      ],
      exposes: [],
    });

    const actual = await updateCache(remoteEntry);

    expect(actual.actions).toEqual({ 'dep-a': { action: 'scope' } });
  });

  it('should directly share a "shareScope: strict" version', async () => {
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'strict');

    adapters.sharedExternalsRepo.tryGet = vi.fn((): Optional<SharedExternal> =>
      Optional.of(
        mockExternal.shared(
          [
            mockVersion_A.v2_1_2({
              remotes: { 'team/mfe2': { cached: true, requiredVersion: '2.1.2' } },
              action: 'share',
            }),
          ],
          { dirty: false }
        )
      )
    );

    const remoteEntry = mockRemoteEntry_MFE1({
      shared: [mockSharedInfoA.v2_1_1({ shareScope: 'strict', requiredVersion: '~2.1.0' })],
      exposes: [],
    });

    const actual = await updateCache(remoteEntry);
    expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
      'dep-a',
      mockExternal.shared(
        [
          mockVersion_A.v2_1_2({
            remotes: { 'team/mfe2': { cached: true, requiredVersion: '2.1.2' } },
            action: 'share',
          }),
          mockVersion_A.v2_1_1({
            remotes: { 'team/mfe1': { cached: true, requiredVersion: '2.1.1' } },
            action: 'share',
          }),
        ],
        { dirty: false }
      ),
      'strict'
    );

    expect(actual.actions).toEqual({
      'dep-a': { action: 'share' },
    });
  });

  describe('a strict load joining a committed row of its tag', () => {
    // The committed map and getShared serve each strict row from its `remotes[0]`. The loader is stored
    // `cached` like that basis, so `isBetterBasis` would fall through to coverage and then to the name.
    let stored: Record<string, SharedExternal>;

    const committedRow = (external: string, entries: Record<string, string>): SharedExternal =>
      mockExternal.shared(
        [
          mockVersion.shared('2.1.2', external, {
            remotes: { 'team/mfe2': { cached: true, requiredVersion: '2.1.2', entries } },
            action: 'share',
          }),
        ],
        { dirty: false }
      );

    const rowsOf = (external: string) =>
      stored[external]!.versions.map(v => [v.tag, v.action, v.remotes.map(r => r.name)]);

    beforeEach(() => {
      adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'strict');
      adapters.sharedExternalsRepo.tryGet = vi.fn((name: string) => Optional.of(stored[name]!));
      adapters.sharedExternalsRepo.addOrUpdate = vi.fn((name: string, external: SharedExternal) => {
        stored[name] = external;
        return adapters.sharedExternalsRepo;
      });
    });

    // Before the fix, mfe1's two entrypoints outranked mfe2's one and it took the basis.
    it('should keep the committed basis when the loader ships more of the package', async () => {
      stored = { 'dep-a': committedRow('dep-a', { 'dep-a': 'dep-a.js' }) };

      const actual = await updateCache(
        mockRemoteEntry_MFE1({
          shared: [
            mockSharedInfoA.v2_1_2({
              shareScope: 'strict',
              entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' },
            }),
          ],
          exposes: [],
        })
      );

      expect(rowsOf('dep-a')).toEqual([['2.1.2', 'share', ['team/mfe2', 'team/mfe1']]]);
      expect(actual.actions).toEqual({ 'dep-a': { action: 'share' } });
    });

    // Flat: one entrypoint per external, so coverage ties and before the fix 'team/mfe1' won every row on its name.
    it('should keep the committed basis of every flat external on a coverage tie', async () => {
      stored = {
        'dep-a': committedRow('dep-a', { 'dep-a': 'dep-a.js' }),
        'dep-a/sub': committedRow('dep-a/sub', { 'dep-a/sub': 'dep-a-sub.js' }),
      };
      const flat = (packageName: string, file: string) =>
        mockSharedInfo(packageName, {
          singleton: true,
          shareScope: 'strict',
          requiredVersion: '2.1.2',
          version: '2.1.2',
          outFileName: file,
        });

      const actual = await updateCache(
        mockRemoteEntry_MFE1({
          shared: [flat('dep-a', 'dep-a.js'), flat('dep-a/sub', 'dep-a-sub.js')],
          exposes: [],
        })
      );

      expect(rowsOf('dep-a')).toEqual([['2.1.2', 'share', ['team/mfe2', 'team/mfe1']]]);
      expect(rowsOf('dep-a/sub')).toEqual([['2.1.2', 'share', ['team/mfe2', 'team/mfe1']]]);
      expect(actual.actions).toEqual({
        'dep-a': { action: 'share' },
        'dep-a/sub': { action: 'share' },
      });
    });
  });

  it('should override a shared external to list with same version when shareScope', async () => {
    adapters.versionCheck.isCompatible = vi.fn(() => true);

    adapters.sharedExternalsRepo.tryGet = vi.fn((): Optional<SharedExternal> =>
      Optional.of(
        mockExternal.shared(
          [mockVersion_A.v2_1_2({ remotes: { 'team/mfe2': { cached: true } }, action: 'share' })],
          { dirty: false }
        )
      )
    );

    const remoteEntry = mockRemoteEntry_MFE1({
      shared: [mockSharedInfoA.v2_1_2({ shareScope: 'custom-scope' })],
      exposes: [],
    });

    const result = await updateCache(remoteEntry);

    expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
      'dep-a',
      mockExternal.shared(
        [
          mockVersion_A.v2_1_2({ remotes: { 'team/mfe2': { cached: true } }, action: 'share' }),
          mockVersion_A.v2_1_2({ remotes: { 'team/mfe1': { cached: false } }, action: 'skip' }),
        ],
        { dirty: false }
      ),
      'custom-scope'
    );

    expect(result.actions).toEqual({
      'dep-a': {
        action: 'skip',
        covered: ['dep-a'],
        override: { 'dep-a': mockScopeUrl_MFE2({ file: 'dep-a.js' }) },
      },
    });
  });

  it('should add an scoped external if shared incompatible external exists', async () => {
    adapters.versionCheck.isCompatible = vi.fn(() => false);
    // Tags differ, so the range decides: a copy only accepts its own version regardless of range.
    adapters.versionCheck.compare = vi.fn(createVersionCheck().compare);

    adapters.sharedExternalsRepo.tryGet = vi.fn((): Optional<SharedExternal> =>
      Optional.of(
        mockExternal.shared(
          [mockVersion_B.v2_2_2({ remotes: { 'team/mfe2': { cached: true } }, action: 'share' })],
          { dirty: false }
        )
      )
    );

    const remoteEntry = mockRemoteEntry_MFE1({
      shared: [mockSharedInfoB.v2_1_2({ shareScope: 'custom-scope' })],
      exposes: [],
    });

    const actual = await updateCache(remoteEntry);

    expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledTimes(1);
    expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
      'dep-b',
      mockExternal.shared(
        [
          mockVersion_B.v2_2_2({ remotes: { 'team/mfe2': { cached: true } }, action: 'share' }),
          mockVersion_B.v2_1_2({ remotes: { 'team/mfe1': { cached: true } }, action: 'scope' }),
        ],
        { dirty: false }
      ),
      'custom-scope'
    );

    expect(actual.actions).toEqual({
      'dep-b': { action: 'scope' },
    });
  });

  it('should add a shared external if no shared version present.', async () => {
    adapters.sharedExternalsRepo.tryGet = vi.fn((): Optional<SharedExternal> => Optional.empty());
    const remoteEntry = mockRemoteEntry_MFE1({
      shared: [mockSharedInfoA.v2_1_2({ shareScope: 'custom-scope' })],
      exposes: [],
    });
    const actual = await updateCache(remoteEntry);

    expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledTimes(1);
    expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
      'dep-a',
      mockExternal.shared(
        [mockVersion_A.v2_1_2({ remotes: { 'team/mfe1': { cached: true } }, action: 'share' })],
        { dirty: false, servingBuild: 'team/mfe1' }
      ),
      'custom-scope'
    );

    expect(actual.actions).toEqual({
      'dep-a': { action: 'share', override: undefined },
    });
  });
});
