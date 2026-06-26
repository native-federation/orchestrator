import { createProcessRemoteEntries } from './process-remote-entries';
import { ForProcessingRemoteEntries } from '../driver-ports/init/for-processing-remote-entries.port';
import { DrivingContract } from '../driving-ports/driving.contract';
import { LoggingConfig } from '../config/log.contract';
import { Optional } from 'lib/utils/optional';
import { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { SharedExternal } from 'lib/core/1.domain';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockRemoteEntry_MFE1 } from 'lib/testing/domain/remote-entry/remote-entry.mock';
import { mockSharedInfo, mockSharedInfoE } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockScopedVersion, mockVersion_E } from 'lib/testing/domain/externals/version.mock';

describe('createProcessRemoteEntries - scoped', () => {
  let processRemoteEntries: ForProcessingRemoteEntries;
  let config: LoggingConfig & ModeConfig;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();

    processRemoteEntries = createProcessRemoteEntries(config, adapters);

    adapters.sharedExternalsRepo.tryGet = vi.fn(_e => Optional.empty<SharedExternal>());

    adapters.versionCheck.isValidSemver = vi.fn(() => true);
    adapters.versionCheck.compare = vi.fn(() => 0);
  });

  describe('default cases', () => {
    it('should add a shared external', async () => {
      const remoteEntries = [mockRemoteEntry_MFE1({ shared: [mockSharedInfoE.v1_2_3()] })];

      await processRemoteEntries(remoteEntries);

      expect(adapters.scopedExternalsRepo.addExternal).toHaveBeenCalledTimes(1);
      expect(adapters.scopedExternalsRepo.addExternal).toHaveBeenCalledWith(
        'team/mfe1',
        'dep-e',
        mockVersion_E.v1_2_3()
      );
    });
  });

  describe('handling a missing version property', () => {
    it('should add the correct tag if missing', async () => {
      adapters.versionCheck.smallestVersion = vi.fn((): string => '1.2.1');
      const remoteEntries = [
        mockRemoteEntry_MFE1({ shared: [mockSharedInfo('dep-e', { requiredVersion: '~1.2.1' })] }),
      ];

      await processRemoteEntries(remoteEntries);

      expect(adapters.scopedExternalsRepo.addExternal).toHaveBeenCalledTimes(1);
      expect(adapters.scopedExternalsRepo.addExternal).toHaveBeenCalledWith(
        'team/mfe1',
        'dep-e',
        mockScopedVersion('1.2.1', 'dep-e')
      );
      expect(config.log.warn).toHaveBeenCalledWith(
        2,
        "[team/mfe1][dep-e] Version 'undefined' is not a valid version."
      );
    });

    it('should skip the external when version is invalid and skipInvalidExternalVersions is set', async () => {
      config.profile.skipInvalidExternalVersions = true;
      adapters.versionCheck.isValidSemver = vi.fn(() => false);
      const remoteEntries = [
        mockRemoteEntry_MFE1({
          shared: [
            mockSharedInfo('dep-e', { version: 'not-a-version', requiredVersion: '~1.2.1' }),
          ],
        }),
      ];

      await processRemoteEntries(remoteEntries);

      expect(adapters.scopedExternalsRepo.addExternal).not.toHaveBeenCalled();
      expect(config.log.warn).toHaveBeenCalledWith(
        2,
        "[team/mfe1][dep-e] Version 'not-a-version' is not a valid version. Skipping external."
      );
    });
  });
});
