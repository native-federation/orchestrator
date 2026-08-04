import { createGenerateImportMap } from './generate-import-map';
import { createUpdateCache } from './update-cache';
import { createConvertToImportMap } from './convert-to-import-map';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { Optional } from 'lib/utils/optional';
import {
  GLOBAL_SCOPE,
  type ImportMap,
  type RemoteEntry,
  type SharedExternal,
} from 'lib/core/1.domain';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';
import type { DrivingContract } from '../driving-ports/driving.contract';
import {
  mockRemoteInfo_MFE1,
  mockRemoteInfo_MFE2,
  mockRemoteInfo_MFE3,
} from 'lib/testing/domain/remote-info/remote-info.mock';
import {
  mockRemoteEntry_MFE2,
  mockRemoteEntry_MFE3,
} from 'lib/testing/domain/remote-entry/remote-entry.mock';
import { mockSharedInfoA } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockVersion_A } from 'lib/testing/domain/externals/version.mock';
import { mockExternal } from 'lib/testing/domain/externals/external.mock';
import {
  mockScopeUrl_MFE1,
  mockScopeUrl_MFE2,
  mockScopeUrl_MFE3,
} from 'lib/testing/domain/scope-url.mock';

/**
 * `update-cache` → `convert-to-import-map` on the dynamic path, against a map `generate-import-map` really
 * committed — the one question no single-step spec can ask, because the defect it guards is a *disagreement*
 * between the two: `covered` says the shared version serves a specifier, so nothing self-fills it, while the
 * committed `imports` never published it and the joining remote has no way to resolve it.
 *
 * It takes a third copy of one tag to reach: the copy that brought the specifier joined at runtime too, so it
 * only ever mapped the specifier into its *own* scope. `e2e/pooling/entrypoints.e2e.spec.ts` covers the merge
 * itself but joins through a second `init`, not `loadRemoteModule`, and CI does not run the e2e suite
 * (`npm run test-e2e` is local only) — so this file is the gate.
 */
describe('entrypoint coverage on the dynamic path (integration)', () => {
  let config: LoggingConfig & ModeConfig;
  let adapters: DrivingContract;
  let stored: SharedExternal;

  // The committed map: mfe1 alone was resolved at init, so `imports` holds its `dep-a` and nothing else.
  const init = (): Promise<ImportMap> => createGenerateImportMap(config, adapters)();

  // What `init-remote-entry.flow` runs for a remote loaded at runtime, minus pooling.
  const join = (entry: RemoteEntry): Promise<ImportMap> =>
    createUpdateCache(config, adapters)(entry).then(createConvertToImportMap(config, adapters));

  const withSub = (version: 'v2_1_1' | 'v2_1_2') =>
    mockSharedInfoA[version]({ entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' } });

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();

    adapters.versionCheck.isValidSemver = vi.fn(() => true);
    adapters.versionCheck.compare = vi.fn(() => 0);
    adapters.versionCheck.isCompatible = vi.fn(() => true);

    stored = mockExternal.shared([
      mockVersion_A.v2_1_2({
        action: 'share',
        remotes: { 'team/mfe1': { entries: { 'dep-a': 'dep-a.js' } } },
      }),
    ]);

    adapters.sharedExternalsRepo.tryGet = vi.fn(() => Optional.of(stored));
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({ 'dep-a': stored }));
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'global');
    adapters.sharedExternalsRepo.addOrUpdate = vi.fn((_name: string, external: SharedExternal) => {
      stored = external;
      return adapters.sharedExternalsRepo;
    });

    adapters.remoteInfoRepo.getAll = vi.fn(() => ({}));
    adapters.scopedExternalsRepo.getAll = vi.fn(() => ({}));
    adapters.remoteInfoRepo.tryGet = vi.fn(name => {
      if (name === 'team/mfe1') return Optional.of(mockRemoteInfo_MFE1({ exposes: [] }));
      if (name === 'team/mfe2') return Optional.of(mockRemoteInfo_MFE2({ exposes: [] }));
      if (name === 'team/mfe3') return Optional.of(mockRemoteInfo_MFE3({ exposes: [] }));
      return Optional.empty();
    });
  });

  // mfe2 and mfe3 both build the shared tag and both bundle `/sub`, which the cached basis does not.
  // mfe2 merges in and serves `/sub` from its own build — into its own scope, since the map is committed.
  // mfe3 is then told `/sub` is covered, but the only copy covering it is mfe2, whose file the committed
  // `imports` never named: mfe3 must serve `/sub` itself or be left with an unresolvable specifier.
  it('should self-fill a specifier only a runtime-joined copy of the shared version provides', async () => {
    const committed = await init();
    expect(committed.imports).toEqual({ 'dep-a': mockScopeUrl_MFE1({ file: 'dep-a.js' }) });

    const mfe2 = await join(mockRemoteEntry_MFE2({ exposes: [], shared: [withSub('v2_1_2')] }));
    expect(mfe2.scopes![mockScopeUrl_MFE2()]).toEqual({
      'dep-a/sub': mockScopeUrl_MFE2({ file: 'dep-a-sub.js' }),
    });
    // Scoped to mfe2, so no other remote resolves through it — the committed `imports` are unchanged.
    expect(mfe2.imports).toEqual({});

    const mfe3 = await join(mockRemoteEntry_MFE3({ exposes: [], shared: [withSub('v2_1_2')] }));
    expect(mfe3.scopes![mockScopeUrl_MFE3()]).toEqual({
      'dep-a/sub': mockScopeUrl_MFE3({ file: 'dep-a-sub.js' }),
    });
  });

  // The same disagreement decides whether a copy on *another* tag is torn, which is what the coverage
  // settings act on: `/sub` sits in the version's surface but not in the map, so mfe3 does tear and the
  // policy has to see it. Left to `convert-to-import-map` alone it would throw here instead.
  it('should treat a specifier only a runtime-joined copy provides as a tear for another tag', async () => {
    await init();
    await join(mockRemoteEntry_MFE2({ exposes: [], shared: [withSub('v2_1_2')] }));

    config.strict.strictEntryPointCoverage = true;
    await expect(
      join(mockRemoteEntry_MFE3({ exposes: [], shared: [withSub('v2_1_1')] }))
    ).rejects.toThrow("Could not process remote 'team/mfe3'");

    expect(config.log.error).toHaveBeenCalledWith(
      8,
      `[${GLOBAL_SCOPE}][team/mfe3][dep-a] Entrypoints not covered by the shared version: dep-a/sub.`
    );
  });
});
