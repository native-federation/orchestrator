import { DrivingContract } from '../driving-ports/driving.contract';
import { LoggingConfig } from '../config/log.contract';
import { Optional } from 'lib/utils/optional';
import { ForUpdatingCache } from 'lib/core/2.app/driver-ports/init/for-updating-cache';
import { createUpdateCache } from './update-cache';
import { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { RemoteInfo, SharedExternal } from 'lib/core/1.domain';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import {
  mockRemoteInfo_MFE1,
  mockRemoteInfo_MFE2,
} from 'lib/testing/domain/remote-info/remote-info.mock';
import { mockExternal } from 'lib/testing/domain/externals/external.mock';
import { mockVersion_A, mockVersion_B } from 'lib/testing/domain/externals/version.mock';
import { mockRemoteEntry_MFE1 } from 'lib/testing/domain/remote-entry/remote-entry.mock';
import {
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

    updateCache = createUpdateCache(config, adapters);
  });

  it('should add version as "skip" if shared compatible version exists', async () => {
    adapters.versionCheck.isCompatible = vi.fn(() => true);

    adapters.sharedExternalsRepo.tryGet = vi.fn(
      (): Optional<SharedExternal> =>
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
      'dep-a': { action: 'skip', override: mockScopeUrl_MFE2({ file: 'dep-a.js' }) },
    });
  });

  it('should directly share a "shareScope: strict" version', async () => {
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'strict');

    adapters.sharedExternalsRepo.tryGet = vi.fn(
      (): Optional<SharedExternal> =>
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

  it('should override a shared external to list with same version when shareScope', async () => {
    adapters.versionCheck.isCompatible = vi.fn(() => true);

    adapters.sharedExternalsRepo.tryGet = vi.fn(
      (): Optional<SharedExternal> =>
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
          mockVersion_A.v2_1_2({
            remotes: { 'team/mfe2': { cached: true }, 'team/mfe1': { cached: false } },
            action: 'share',
          }),
        ],
        { dirty: false }
      ),
      'custom-scope'
    );

    expect(result.actions).toEqual({
      'dep-a': { action: 'skip', override: mockScopeUrl_MFE2({ file: 'dep-a.js' }) },
    });
  });

  it('should add an scoped external if shared incompatible external exists', async () => {
    adapters.versionCheck.isCompatible = vi.fn(() => false);

    adapters.sharedExternalsRepo.tryGet = vi.fn(
      (): Optional<SharedExternal> =>
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
        { dirty: false }
      ),
      'custom-scope'
    );

    expect(actual.actions).toEqual({
      'dep-a': { action: 'share', override: undefined },
    });
  });
});
