import { ForGeneratingImportMap } from '../../driver-ports/init/for-generating-import-map';
import { DrivingContract } from '../../driving-ports/driving.contract';
import { createGenerateImportMap } from './generate-import-map';
import { LoggingConfig } from '../../config/log.contract';
import { ModeConfig } from '../../config/mode.contract';
import { Optional } from 'lib/utils/optional';
import { RemoteInfo } from 'lib/1.domain';
import { mockConfig } from 'lib/6.mocks/config.mock';
import { mockAdapters } from 'lib/6.mocks/adapters.mock';
import {
  mockRemoteInfo_MFE1,
  mockRemoteInfo_MFE2,
} from 'lib/6.mocks/domain/remote-info/remote-info.mock';
import {
  mockExternal_A,
  mockExternal_E,
  mockExternal_F,
} from 'lib/6.mocks/domain/externals/external.mock';
import { mockVersion_A } from 'lib/6.mocks/domain/externals/version.mock';
import { mockScopeUrl_MFE1, mockScopeUrl_MFE2 } from 'lib/6.mocks/domain/scope-url.mock';

const HASH_A = 'sha384-AAA';
const HASH_B = 'sha384-BBB';
const HASH_E = 'sha384-EEE';
const HASH_F = 'sha384-FFF';
const HASH_CHUNK = 'sha384-CHK';
const HASH_COMP_A = 'sha384-CMP-A';
const HASH_COMP_B = 'sha384-CMP-B';

describe('createGenerateImportMap (integrity)', () => {
  let generateImportMap: ForGeneratingImportMap;
  let adapters: Pick<
    DrivingContract,
    'remoteInfoRepo' | 'scopedExternalsRepo' | 'sharedExternalsRepo' | 'sharedChunksRepo'
  >;
  let config: LoggingConfig & ModeConfig;

  const remoteInfoFor = (
    mfe: 'team/mfe1' | 'team/mfe2',
    integrity?: Record<string, string>
  ): RemoteInfo => {
    const base = mfe === 'team/mfe1' ? mockRemoteInfo_MFE1() : mockRemoteInfo_MFE2();
    return integrity ? { ...base, integrity } : base;
  };

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();

    adapters.remoteInfoRepo.getAll = jest.fn(() => ({}));
    adapters.scopedExternalsRepo.getAll = jest.fn(() => ({}));
    adapters.sharedExternalsRepo.getFromScope = jest.fn(() => ({}));
    adapters.sharedExternalsRepo.getScopes = jest.fn(() => []);
    adapters.sharedChunksRepo.tryGet = jest.fn(() => Optional.empty());
    adapters.remoteInfoRepo.tryGet = jest.fn(() => Optional.empty<RemoteInfo>());

    generateImportMap = createGenerateImportMap(config, adapters);
  });

  it('should omit the integrity block when no remote provides hashes', async () => {
    adapters.remoteInfoRepo.tryGet = jest.fn(remote => {
      if (remote === 'team/mfe1') return Optional.of(remoteInfoFor('team/mfe1'));
      return Optional.empty<RemoteInfo>();
    });
    adapters.remoteInfoRepo.getAll = jest.fn(() => ({
      'team/mfe1': remoteInfoFor('team/mfe1'),
    }));

    const actual = await generateImportMap();

    expect(actual.integrity).toBeUndefined();
  });

  it('should add integrity for exposed remote modules', async () => {
    const integrity = { 'component-a.js': HASH_COMP_A };
    adapters.remoteInfoRepo.tryGet = jest.fn(remote => {
      if (remote === 'team/mfe1') return Optional.of(remoteInfoFor('team/mfe1', integrity));
      return Optional.empty<RemoteInfo>();
    });
    adapters.remoteInfoRepo.getAll = jest.fn(() => ({
      'team/mfe1': remoteInfoFor('team/mfe1', integrity),
    }));

    const actual = await generateImportMap();

    expect(actual.integrity).toEqual({
      [mockScopeUrl_MFE1({ file: 'component-a.js' })]: HASH_COMP_A,
    });
  });

  it('should add integrity for scoped externals', async () => {
    const integrity = { 'dep-e.js': HASH_E, 'dep-f.js': HASH_F };
    adapters.remoteInfoRepo.tryGet = jest.fn(remote => {
      if (remote === 'team/mfe1')
        return Optional.of(remoteInfoFor('team/mfe1', integrity));
      return Optional.empty<RemoteInfo>();
    });
    adapters.scopedExternalsRepo.getAll = jest.fn(() => ({
      'team/mfe1': { ...mockExternal_E(), ...mockExternal_F() },
    }));

    const actual = await generateImportMap();

    expect(actual.integrity).toEqual({
      [mockScopeUrl_MFE1({ file: 'dep-e.js' })]: HASH_E,
      [mockScopeUrl_MFE1({ file: 'dep-f.js' })]: HASH_F,
    });
  });

  it('should skip integrity entries when the file has no hash', async () => {
    const integrity = { 'dep-e.js': HASH_E };
    adapters.remoteInfoRepo.tryGet = jest.fn(remote => {
      if (remote === 'team/mfe1')
        return Optional.of(remoteInfoFor('team/mfe1', integrity));
      return Optional.empty<RemoteInfo>();
    });
    adapters.scopedExternalsRepo.getAll = jest.fn(() => ({
      'team/mfe1': { ...mockExternal_E(), ...mockExternal_F() },
    }));

    const actual = await generateImportMap();

    expect(actual.integrity).toEqual({
      [mockScopeUrl_MFE1({ file: 'dep-e.js' })]: HASH_E,
    });
  });

  it('should add integrity for globally shared externals', async () => {
    const integrity = { 'dep-a.js': HASH_A };
    adapters.remoteInfoRepo.tryGet = jest.fn(remote => {
      if (remote === 'team/mfe1')
        return Optional.of(remoteInfoFor('team/mfe1', integrity));
      return Optional.empty<RemoteInfo>();
    });
    adapters.sharedExternalsRepo.getFromScope = jest.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [mockVersion_A.v2_1_1({ action: 'share', remotes: ['team/mfe1'] })],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual.integrity).toEqual({
      [mockScopeUrl_MFE1({ file: 'dep-a.js' })]: HASH_A,
    });
  });

  it('should add integrity for share-scope shared externals', async () => {
    const integrity1 = { 'dep-a.js': HASH_A };
    const integrity2 = { 'dep-b.js': HASH_B };
    adapters.remoteInfoRepo.tryGet = jest.fn(remote => {
      if (remote === 'team/mfe1') return Optional.of(remoteInfoFor('team/mfe1', integrity1));
      if (remote === 'team/mfe2') return Optional.of(remoteInfoFor('team/mfe2', integrity2));
      return Optional.empty<RemoteInfo>();
    });
    adapters.sharedExternalsRepo.getScopes = jest.fn(() => ['custom-scope']);
    const sharedForScope = {
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [mockVersion_A.v2_1_1({ action: 'share', remotes: ['team/mfe1'] })],
      }),
    };
    adapters.sharedExternalsRepo.getFromScope = jest.fn(scope =>
      scope === 'custom-scope' ? sharedForScope : {}
    );

    const actual = await generateImportMap();

    expect(actual.integrity).toEqual({
      [mockScopeUrl_MFE1({ file: 'dep-a.js' })]: HASH_A,
    });
  });

  it('should add integrity for chunk imports', async () => {
    const integrity = { 'dep-a.js': HASH_A, 'shared-chunk.js': HASH_CHUNK };
    adapters.remoteInfoRepo.tryGet = jest.fn(remote => {
      if (remote === 'team/mfe1') return Optional.of(remoteInfoFor('team/mfe1', integrity));
      return Optional.empty<RemoteInfo>();
    });
    adapters.sharedExternalsRepo.getFromScope = jest.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_1({
            action: 'share',
            remotes: { 'team/mfe1': { bundle: 'shared' } },
          }),
        ],
      }),
    }));
    adapters.sharedChunksRepo.tryGet = jest.fn((remote, bundle) => {
      if (remote === 'team/mfe1' && bundle === 'shared') {
        return Optional.of(['shared-chunk.js']);
      }
      return Optional.empty();
    });

    const actual = await generateImportMap();

    expect(actual.integrity).toEqual({
      [mockScopeUrl_MFE1({ file: 'dep-a.js' })]: HASH_A,
      [mockScopeUrl_MFE1({ file: 'shared-chunk.js' })]: HASH_CHUNK,
    });
  });

  it('should add integrity across multiple remotes', async () => {
    const integrity1 = { 'component-a.js': HASH_COMP_A };
    const integrity2 = { 'component-b.js': HASH_COMP_B };
    adapters.remoteInfoRepo.tryGet = jest.fn(remote => {
      if (remote === 'team/mfe1') return Optional.of(remoteInfoFor('team/mfe1', integrity1));
      if (remote === 'team/mfe2') return Optional.of(remoteInfoFor('team/mfe2', integrity2));
      return Optional.empty<RemoteInfo>();
    });
    adapters.remoteInfoRepo.getAll = jest.fn(() => ({
      'team/mfe1': remoteInfoFor('team/mfe1', integrity1),
      'team/mfe2': remoteInfoFor('team/mfe2', integrity2),
    }));

    const actual = await generateImportMap();

    expect(actual.integrity).toEqual({
      [mockScopeUrl_MFE1({ file: 'component-a.js' })]: HASH_COMP_A,
      [mockScopeUrl_MFE2({ file: 'component-b.js' })]: HASH_COMP_B,
    });
  });
});
