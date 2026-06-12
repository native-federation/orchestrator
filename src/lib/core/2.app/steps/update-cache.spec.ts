import type { Mock } from 'vitest';
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
import { mockExposedModuleA } from 'lib/testing/domain/remote-entry/exposes-info.mock';
import {
  mockSharedInfo,
  mockSharedInfoA,
  mockSharedInfoB,
} from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockRemoteModuleA } from 'lib/testing/domain/remote-info/remote-module.mock';

describe('createProcessDynamicRemoteEntry', () => {
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

    updateCache = createUpdateCache(config, adapters);
  });

  describe('cleaning up before processing', () => {
    it('should remove the previous cached version if remoteEntry is marked as override', async () => {
      const remoteEntry = mockRemoteEntry_MFE1({
        override: true,
        shared: [mockSharedInfoA.v2_1_1(), mockSharedInfoB.v2_1_2()],
        exposes: [mockExposedModuleA()],
      });

      await updateCache(remoteEntry);

      expect(adapters.remoteInfoRepo.remove).toHaveBeenCalledWith('team/mfe1');
      expect(adapters.scopedExternalsRepo.remove).toHaveBeenCalledWith('team/mfe1');
      expect(adapters.sharedExternalsRepo.removeFromAllScopes).toHaveBeenCalledWith('team/mfe1');
    });

    it('should not remove the old version if the remoteEntry is not marked as override', async () => {
      const remoteEntry = mockRemoteEntry_MFE1({
        override: false,
        shared: [mockSharedInfoA.v2_1_1(), mockSharedInfoB.v2_1_2()],
        exposes: [mockExposedModuleA()],
      });

      await updateCache(remoteEntry);

      expect(adapters.remoteInfoRepo.remove).not.toHaveBeenCalled();
      expect(adapters.scopedExternalsRepo.remove).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.removeFromAllScopes).not.toHaveBeenCalled();
    });

    it('should not remove the old version if the remoteEntry is missing the override flag', async () => {
      const remoteEntry = mockRemoteEntry_MFE1({
        shared: [mockSharedInfoA.v2_1_1(), mockSharedInfoB.v2_1_2()],
        exposes: [mockExposedModuleA()],
      });

      await updateCache(remoteEntry);

      expect(adapters.remoteInfoRepo.remove).not.toHaveBeenCalled();
      expect(adapters.scopedExternalsRepo.remove).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.removeFromAllScopes).not.toHaveBeenCalled();
    });
  });

  describe('addRemoteInfoToStorage', () => {
    it('should add remote info with exposed modules to storage', async () => {
      const remoteEntry = mockRemoteEntry_MFE1({
        override: false,
        shared: [],
        exposes: [mockExposedModuleA()],
      });

      const actual = await updateCache(remoteEntry);

      expect(adapters.remoteInfoRepo.addOrUpdate).toHaveBeenCalledTimes(1);
      expect(adapters.remoteInfoRepo.addOrUpdate).toHaveBeenCalledWith(
        'team/mfe1',
        mockRemoteInfo_MFE1({ exposes: [mockRemoteModuleA()] })
      );
      expect(actual.actions).toEqual({});
    });

    it('should propagate the integrity map onto the stored RemoteInfo', async () => {
      const integrity = { 'component-a.js': 'sha384-CMP-A' };
      const remoteEntry = mockRemoteEntry_MFE1({
        override: false,
        shared: [],
        exposes: [mockExposedModuleA()],
        integrity,
      });

      await updateCache(remoteEntry);

      expect(adapters.remoteInfoRepo.addOrUpdate).toHaveBeenCalledWith('team/mfe1', {
        ...mockRemoteInfo_MFE1({ exposes: [mockRemoteModuleA()] }),
        integrity,
      });
    });

    it('should omit integrity from the stored RemoteInfo when remoteEntry has none', async () => {
      const remoteEntry = mockRemoteEntry_MFE1({
        override: false,
        shared: [],
        exposes: [mockExposedModuleA()],
      });

      await updateCache(remoteEntry);

      const stored = (adapters.remoteInfoRepo.addOrUpdate as Mock).mock.calls[0][1];
      expect(stored).not.toHaveProperty('integrity');
    });
  });

  describe('handling a missing version property', () => {
    it('should handle invalid versions in strict mode', async () => {
      config.strict.strictExternalVersion = true;
      adapters.versionCheck.isValidSemver = vi.fn(() => false);

      const remoteEntry = mockRemoteEntry_MFE1({
        shared: [
          mockSharedInfo('dep-a', { version: 'invalid-version', requiredVersion: '~1.2.1' }),
        ],
        exposes: [],
      });
      await expect(updateCache(remoteEntry)).rejects.toThrow(
        "Could not process remote 'team/mfe1'"
      );
      expect(config.log.error).toHaveBeenCalledWith(
        8,
        "[team/mfe1][dep-a] Version 'invalid-version' is not a valid version."
      );
    });

    it('should handle undefined versions in strict mode', async () => {
      config.strict.strictExternalVersion = true;
      adapters.versionCheck.isValidSemver = vi.fn(() => false);

      const remoteEntry = mockRemoteEntry_MFE1({
        shared: [mockSharedInfo('dep-a', { version: undefined, requiredVersion: '~1.2.1' })],
        exposes: [],
      });
      await expect(updateCache(remoteEntry)).rejects.toThrow(
        "Could not process remote 'team/mfe1'"
      );
      expect(config.log.error).toHaveBeenCalledWith(
        8,
        "[team/mfe1][dep-a] Version 'undefined' is not a valid version."
      );
    });
  });
});
