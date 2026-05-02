import { LoggingConfig } from '../../config/log.contract';
import { ForConvertingToImportMap } from 'lib/2.app/driver-ports/dynamic-init/for-converting-to-import-map';
import { createConvertToImportMap } from './convert-to-import-map';
import { RemoteEntry, SharedInfoActions } from 'lib/1.domain';
import { mockConfig } from 'lib/6.mocks/config.mock';
import { mockRemoteEntry_MFE2 } from 'lib/6.mocks/domain/remote-entry/remote-entry.mock';
import { mockScopeUrl_MFE2 } from 'lib/6.mocks/domain/scope-url.mock';
import {
  mockSharedInfoA,
  mockSharedInfoE,
  mockSharedInfoF,
} from 'lib/6.mocks/domain/remote-entry/shared-info.mock';
import { mockChunkRepository } from 'lib/6.mocks/adapters/chunk.repository.mock';
import { Optional } from 'lib/utils/optional';
import { DrivingContract } from 'lib/2.app/driving-ports/driving.contract';

const HASH_A = 'sha384-AAA';
const HASH_E = 'sha384-EEE';
const HASH_F = 'sha384-FFF';
const HASH_COMP_B = 'sha384-CMP-B';
const HASH_COMP_C = 'sha384-CMP-C';
const HASH_CHUNK = 'sha384-CHK';

describe('createConvertToImportMap (integrity)', () => {
  let convertToImportMap: ForConvertingToImportMap;
  let config: LoggingConfig;
  let ports: Pick<DrivingContract, 'sharedChunksRepo'>;

  beforeEach(() => {
    config = mockConfig();
    ports = { sharedChunksRepo: mockChunkRepository() };
    convertToImportMap = createConvertToImportMap(config, ports);
  });

  it('should omit the integrity block when remoteEntry has no integrity map', async () => {
    const entry: RemoteEntry = mockRemoteEntry_MFE2({ shared: [] });

    const importMap = await convertToImportMap({ entry, actions: {} });

    expect(importMap.integrity).toBeUndefined();
  });

  it('should add integrity for exposed remote modules', async () => {
    const entry: RemoteEntry = mockRemoteEntry_MFE2({
      shared: [],
      integrity: { 'component-b.js': HASH_COMP_B, 'component-c.js': HASH_COMP_C },
    });

    const importMap = await convertToImportMap({ entry, actions: {} });

    expect(importMap.integrity).toEqual({
      [mockScopeUrl_MFE2({ file: 'component-b.js' })]: HASH_COMP_B,
      [mockScopeUrl_MFE2({ file: 'component-c.js' })]: HASH_COMP_C,
    });
  });

  it('should add integrity for non-singleton (scoped) shared externals', async () => {
    const entry: RemoteEntry = mockRemoteEntry_MFE2({
      exposes: [],
      shared: [mockSharedInfoE.v1_2_3(), mockSharedInfoF.v1_2_4()],
      integrity: { 'dep-e.js': HASH_E, 'dep-f.js': HASH_F },
    });

    const importMap = await convertToImportMap({ entry, actions: {} });

    expect(importMap.integrity).toEqual({
      [mockScopeUrl_MFE2({ file: 'dep-e.js' })]: HASH_E,
      [mockScopeUrl_MFE2({ file: 'dep-f.js' })]: HASH_F,
    });
  });

  it('should skip integrity entries when the file has no hash', async () => {
    const entry: RemoteEntry = mockRemoteEntry_MFE2({
      exposes: [],
      shared: [mockSharedInfoE.v1_2_3(), mockSharedInfoF.v1_2_4()],
      integrity: { 'dep-e.js': HASH_E },
    });

    const importMap = await convertToImportMap({ entry, actions: {} });

    expect(importMap.integrity).toEqual({
      [mockScopeUrl_MFE2({ file: 'dep-e.js' })]: HASH_E,
    });
  });

  it('should add integrity for singleton scope-action externals', async () => {
    const entry: RemoteEntry = mockRemoteEntry_MFE2({
      exposes: [],
      shared: [mockSharedInfoA.v2_1_2()],
      integrity: { 'dep-a.js': HASH_A },
    });
    const actions: SharedInfoActions = { 'dep-a': { action: 'scope' } };

    const importMap = await convertToImportMap({ entry, actions });

    expect(importMap.integrity).toEqual({
      [mockScopeUrl_MFE2({ file: 'dep-a.js' })]: HASH_A,
    });
  });

  it('should add integrity for share-action externals with shareScope', async () => {
    const entry: RemoteEntry = mockRemoteEntry_MFE2({
      exposes: [],
      shared: [mockSharedInfoA.v2_1_2({ shareScope: 'custom-scope' })],
      integrity: { 'dep-a.js': HASH_A },
    });
    const actions: SharedInfoActions = { 'dep-a': { action: 'share' } };

    const importMap = await convertToImportMap({ entry, actions });

    expect(importMap.integrity).toEqual({
      [mockScopeUrl_MFE2({ file: 'dep-a.js' })]: HASH_A,
    });
  });

  it('should add integrity for globally shared singletons (default case)', async () => {
    const entry: RemoteEntry = mockRemoteEntry_MFE2({
      exposes: [],
      shared: [mockSharedInfoA.v2_1_2()],
      integrity: { 'dep-a.js': HASH_A },
    });
    const actions: SharedInfoActions = { 'dep-a': { action: 'share' } };

    const importMap = await convertToImportMap({ entry, actions });

    expect(importMap.integrity).toEqual({
      [mockScopeUrl_MFE2({ file: 'dep-a.js' })]: HASH_A,
    });
  });

  it('should not add integrity for skipped externals (no URL emitted)', async () => {
    const entry: RemoteEntry = mockRemoteEntry_MFE2({
      exposes: [],
      shared: [mockSharedInfoA.v2_1_2()],
      integrity: { 'dep-a.js': HASH_A },
    });
    const actions: SharedInfoActions = { 'dep-a': { action: 'skip' } };

    const importMap = await convertToImportMap({ entry, actions });

    expect(importMap.integrity).toBeUndefined();
  });

  it('should add integrity for chunk imports', async () => {
    const entry: RemoteEntry = mockRemoteEntry_MFE2({
      exposes: [],
      shared: [],
      chunks: { 'mapping-or-exposed': ['shared-chunk.js'] },
      integrity: { 'shared-chunk.js': HASH_CHUNK },
    });
    ports.sharedChunksRepo.tryGet = jest.fn((remote, bundle) => {
      if (remote === 'team/mfe2' && bundle === 'mapping-or-exposed') {
        return Optional.of(['shared-chunk.js']);
      }
      return Optional.empty();
    });

    const importMap = await convertToImportMap({ entry, actions: {} });

    expect(importMap.integrity).toEqual({
      [mockScopeUrl_MFE2({ file: 'shared-chunk.js' })]: HASH_CHUNK,
    });
  });
});
