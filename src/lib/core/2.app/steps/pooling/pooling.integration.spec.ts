import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { Optional } from 'lib/utils/optional';
import {
  type RemoteEntry,
  type RemoteInfo,
  type SharedExternal,
  type SharedVersion,
} from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createDetermineSharedExternals } from '../determine-shared-externals';
import { createPoolSharedExternals } from './pool-shared-externals';
import { createGenerateImportMap } from '../generate-import-map';
import { createUpdateCache } from '../update-cache';
import { createPoolDynamicExternals } from './pool-dynamic-externals';
import { createConvertToImportMap } from '../convert-to-import-map';

/**
 * End-to-end coherence: pooling makes a whole `@framework/*` family resolve from one remote build,
 * even though the per-external resolver (determine-shared-externals) would otherwise anchor
 * different members on different remotes.
 */
describe('pooling (integration)', () => {
  const SCOPE = {
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
    'team/mfe-c': 'http://mfe-c/',
  } as const;

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    config.profile.useAutoExternalPooling = true;

    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-pool-integration'),
      clearStorage: true,
    });

    adapters.remoteInfoRepo.getAll = vi.fn(() => ({}));
    adapters.scopedExternalsRepo.getAll = vi.fn(() => ({}));
    adapters.sharedChunksRepo.tryGet = vi.fn(() => Optional.empty());
    adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
      name in SCOPE
        ? Optional.of({ scopeUrl: SCOPE[name as keyof typeof SCOPE], exposes: [] } as RemoteInfo)
        : Optional.empty<RemoteInfo>()
    );
  });

  const meta = (remote: string, external: string, req: string) =>
    mockVersionRemote(remote, external, { requiredVersion: req, strictVersion: true });

  const version = (
    tag: string,
    external: string,
    remotes: { remote: string; req: string }[]
  ): SharedVersion => ({
    tag,
    host: false,
    action: 'skip',
    remotes: remotes.map(r => meta(r.remote, external, r.req)),
  });

  const seed = (name: string, versions: SharedVersion[]) =>
    adapters.sharedExternalsRepo.addOrUpdate(name, { dirty: true, versions }, undefined);

  const runInit = async () => {
    await createDetermineSharedExternals(config, adapters)();
    await createPoolSharedExternals(config, adapters)();
    return createGenerateImportMap(config, adapters)();
  };

  it('anchors an entire @framework family on a single remote build', async () => {
    // mfe-a provides the winning build (17.0.0) for the whole family; mfe-b ships a newer compatible
    // tag. Pooling anchors on mfe-a and mfe-b follows, rather than splitting across two sources.
    seed('@framework/core', [
      version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@framework/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);
    seed('@framework/common', [
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);

    const importMap = await runInit();

    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@framework/common']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@framework/common']).not.toContain(SCOPE['team/mfe-b']);
  });

  it('scopes an incompatible remote whole family, keeping the global family single-source', async () => {
    seed('@framework/core', [
      version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@framework/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('18.0.0', '@framework/core', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);
    seed('@framework/common', [
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('18.0.0', '@framework/common', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);

    const importMap = await runInit();

    // Global family stays single-source (mfe-a), none of it served from the incompatible mfe-c.
    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@framework/common']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@framework/core']).not.toContain(SCOPE['team/mfe-c']);

    // mfe-c serves its own incompatible family from its own scope.
    const cScope = importMap.scopes?.[SCOPE['team/mfe-c']];
    expect(cScope?.['@framework/core']).toContain(SCOPE['team/mfe-c']);
    expect(cScope?.['@framework/common']).toContain(SCOPE['team/mfe-c']);
  });

  it('pools around a partial anchor when no remote covers the union; orphan is scoped-only', async () => {
    // Ragged portfolio: mfe-a has core+common, mfe-b has common+forms — no remote covers the whole
    // family. Pooling anchors on the best partial (mfe-a); the orphan (forms) resolves scoped-only.
    seed('@framework/core', [version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }])]);
    seed('@framework/common', [
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);
    seed('@framework/forms', [version('17.0.0', '@framework/forms', [{ remote: 'team/mfe-b', req: '^17.0.0' }])]);

    const importMap = await runInit();

    // core + common share around the partial anchor mfe-a.
    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@framework/common']).toContain(SCOPE['team/mfe-a']);
    // mfe-b dedups common (same version) — no scoped re-download of it.
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@framework/common']).toBeUndefined();

    // forms is an orphan — no anchor provides it — so it resolves scoped-only from mfe-b.
    expect(importMap.imports['@framework/forms']).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@framework/forms']).toContain(SCOPE['team/mfe-b']);
  });

  it('a tagged design system scopes its whole family for an incompatible consumer (no foreign framework runtime)', async () => {
    // ui joins the framework family via the co-tagged bridge member @framework/core (membership is by
    // shared member, not by name). mfe-b runs framework 18, incompatible with the mfe-a@17 anchor, so
    // it scopes its ENTIRE family — ui included, with NO dedup — so no second framework runtime leaks
    // in through the shared design system.
    const tagged = (remote: string, external: string, req: string) =>
      mockVersionRemote(remote, external, { requiredVersion: req, strictVersion: true, pool: 'framework' });
    seed('@framework/core', [
      { tag: '17.0.0', host: false, action: 'skip', remotes: [tagged('team/mfe-a', '@framework/core', '^17.0.0')] },
      { tag: '18.0.0', host: false, action: 'skip', remotes: [tagged('team/mfe-b', '@framework/core', '^18.0.0')] },
    ]);
    seed('@design-system/ui', [
      { tag: '1.0.0', host: false, action: 'skip', remotes: [tagged('team/mfe-a', '@design-system/ui', '^1.0.0')] },
      { tag: '1.0.0', host: false, action: 'skip', remotes: [tagged('team/mfe-b', '@design-system/ui', '^1.0.0')] },
    ]);

    const importMap = await runInit();

    // Shared family (core + ds) is single-source on mfe-a.
    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@design-system/ui']).toContain(SCOPE['team/mfe-a']);

    // mfe-b scopes its WHOLE family — ds is NOT deduped despite matching version 1.0.0, so no foreign
    // framework runtime leaks in through the shared design system.
    const bScope = importMap.scopes?.[SCOPE['team/mfe-b']];
    expect(bScope?.['@framework/core']).toContain(SCOPE['team/mfe-b']);
    expect(bScope?.['@design-system/ui']).toContain(SCOPE['team/mfe-b']);
  });

  it('coverage-forced dedups a same-version member while incompatibility-forced scopes its whole family', async () => {
    // mfe-a is the anchor (core+common). mfe-b is coverage-forced (uses orphan cdk; core@17 matches).
    // mfe-c is incompatibility-forced (core@18).
    seed('@framework/core', [
      version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.0.0', '@framework/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('18.0.0', '@framework/core', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);
    seed('@framework/common', [
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-c', req: '^17.0.0' }]),
    ]);
    seed('@framework/cdk', [version('17.0.0', '@framework/cdk', [{ remote: 'team/mfe-b', req: '^17.0.0' }])]);

    const importMap = await runInit();

    // core: shared on mfe-a; mfe-b dedups (no scoped copy); mfe-c scopes (incompatible).
    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@framework/core']).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/mfe-c']]?.['@framework/core']).toContain(SCOPE['team/mfe-c']);

    // common: shared on mfe-a; mfe-c scopes it too (whole-family, no dedup) even at the same version.
    expect(importMap.imports['@framework/common']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.scopes?.[SCOPE['team/mfe-c']]?.['@framework/common']).toContain(SCOPE['team/mfe-c']);

    // cdk: orphan → scoped-only on mfe-b.
    expect(importMap.imports['@framework/cdk']).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@framework/cdk']).toContain(SCOPE['team/mfe-b']);
  });

  it('scopes a dynamically-added incompatible remote whole family (dynamic init path)', async () => {
    // Existing coherent anchor (mfe-a @17) already committed.
    const shareVersion = (external: string): SharedExternal => ({
      dirty: false,
      versions: [
        { tag: '17.0.0', host: false, action: 'share', remotes: [meta('team/mfe-a', external, '^17.0.0')] },
      ],
    });
    adapters.sharedExternalsRepo.addOrUpdate('@framework/core', shareVersion('@framework/core'), undefined);
    adapters.sharedExternalsRepo.addOrUpdate('@framework/common', shareVersion('@framework/common'), undefined);

    const entryC: RemoteEntry = {
      name: 'team/mfe-c',
      url: 'http://mfe-c/remoteEntry.json',
      exposes: [],
      shared: [
        mockSharedInfo('@framework/core', {
          requiredVersion: '^18.0.0',
          version: '18.0.0',
          singleton: true,
          strictVersion: true,
        }),
        mockSharedInfo('@framework/common', {
          requiredVersion: '^18.0.0',
          version: '18.0.0',
          singleton: true,
          strictVersion: true,
        }),
      ],
    } as RemoteEntry;

    const updated = await createUpdateCache(config, adapters)(entryC);
    const pooled = await createPoolDynamicExternals(config)(updated);
    const importMap = await createConvertToImportMap(config, adapters)(pooled);

    // The new remote serves its whole family from its own scope; nothing added to the global family.
    const cScope = importMap.scopes?.[SCOPE['team/mfe-c']];
    expect(cScope?.['@framework/core']).toContain(SCOPE['team/mfe-c']);
    expect(cScope?.['@framework/common']).toContain(SCOPE['team/mfe-c']);
    expect(importMap.imports['@framework/core']).toBeUndefined();
    expect(importMap.imports['@framework/common']).toBeUndefined();
  });
});
