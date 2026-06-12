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
import { mockRemoteEntry_MFE1 } from 'lib/testing/domain/remote-entry/remote-entry.mock';
import { mockSharedInfo, mockSharedInfoE } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockVersion, mockVersion_E } from 'lib/testing/domain/externals/version.mock';

describe('createProcessDynamicRemoteEntry - scoped', () => {
  let updateCache: ForUpdatingCache;
  let config: LoggingConfig & ModeConfig;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();

    adapters.versionCheck.isValidSemver = jest.fn(() => true);
    adapters.versionCheck.compare = jest.fn(() => 0);

    adapters.remoteInfoRepo.tryGet = jest.fn(remote => {
      if (remote === 'team/mfe2') return Optional.of(mockRemoteInfo_MFE2({ exposes: [] }));
      if (remote === 'team/mfe1') return Optional.of(mockRemoteInfo_MFE1({ exposes: [] }));
      return Optional.empty<RemoteInfo>();
    });
    adapters.sharedExternalsRepo.tryGet = jest.fn(_e => Optional.empty<SharedExternal>());

    updateCache = createUpdateCache(config, adapters);
  });

  it('should add a scoped external', async () => {
    const remoteEntry = mockRemoteEntry_MFE1({
      shared: [mockSharedInfoE.v1_2_3()],
      exposes: [],
    });
    const actual = await updateCache(remoteEntry);

    expect(adapters.scopedExternalsRepo.addExternal).toHaveBeenCalledTimes(1);
    expect(adapters.scopedExternalsRepo.addExternal).toHaveBeenCalledWith(
      'team/mfe1',
      'dep-e',
      mockVersion_E.v1_2_3()
    );

    expect(actual.actions).toEqual({});
  });

  it('should add the correct tag if missing', async () => {
    adapters.versionCheck.smallestVersion = jest.fn((): string => '1.2.1');

    const remoteEntry = mockRemoteEntry_MFE1({
      shared: [mockSharedInfo('dep-e', { version: undefined, requiredVersion: '~1.2.1' })],
      exposes: [],
    });
    const actual = await updateCache(remoteEntry);

    expect(adapters.scopedExternalsRepo.addExternal).toHaveBeenCalledTimes(1);
    expect(adapters.scopedExternalsRepo.addExternal).toHaveBeenCalledWith(
      'team/mfe1',
      'dep-e',
      mockVersion.scoped('1.2.1', 'dep-e')
    );

    expect(actual.actions).toEqual({});
  });
});
