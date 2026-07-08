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
 * End-to-end coherence: pooling makes a whole `@angular/*` family resolve from one remote build,
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

  it('anchors an entire @angular family on a single remote build', async () => {
    // mfe-a provides the winning build (17.0.0) for the whole family; mfe-b ships a newer,
    // compatible tag. determine elects mfe-a@17.0.0 for every member and pooling anchors the family
    // on it — mfe-b follows the anchor (skip) rather than splitting the family across two sources.
    seed('@angular/core', [
      version('17.0.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@angular/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);
    seed('@angular/common', [
      version('17.0.0', '@angular/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@angular/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);

    const importMap = await runInit();

    expect(importMap.imports['@angular/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@angular/common']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@angular/common']).not.toContain(SCOPE['team/mfe-b']);
  });

  it('scopes an incompatible remote whole family, keeping the global family single-source', async () => {
    seed('@angular/core', [
      version('17.0.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@angular/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('18.0.0', '@angular/core', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);
    seed('@angular/common', [
      version('17.0.0', '@angular/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@angular/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('18.0.0', '@angular/common', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);

    const importMap = await runInit();

    // Global family stays single-source (mfe-a), none of it served from the incompatible mfe-c.
    expect(importMap.imports['@angular/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@angular/common']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@angular/core']).not.toContain(SCOPE['team/mfe-c']);

    // mfe-c serves its own incompatible family from its own scope.
    const cScope = importMap.scopes?.[SCOPE['team/mfe-c']];
    expect(cScope?.['@angular/core']).toContain(SCOPE['team/mfe-c']);
    expect(cScope?.['@angular/common']).toContain(SCOPE['team/mfe-c']);
  });

  it('pools around a partial anchor when no remote covers the union; orphan is scoped-only', async () => {
    // Ragged portfolio: mfe-a has core+common, mfe-b has common+forms. No remote covers the whole
    // @angular family. Pooling anchors on the best partial anchor (mfe-a) and the orphan (forms)
    // resolves scoped-only.
    seed('@angular/core', [version('17.0.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }])]);
    seed('@angular/common', [
      version('17.0.0', '@angular/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.0.0', '@angular/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);
    seed('@angular/forms', [version('17.0.0', '@angular/forms', [{ remote: 'team/mfe-b', req: '^17.0.0' }])]);

    const importMap = await runInit();

    // core + common share around the partial anchor mfe-a.
    expect(importMap.imports['@angular/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@angular/common']).toContain(SCOPE['team/mfe-a']);
    // mfe-b dedups common (same version) — no scoped re-download of it.
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@angular/common']).toBeUndefined();

    // forms is an orphan — no anchor provides it — so it resolves scoped-only from mfe-b.
    expect(importMap.imports['@angular/forms']).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@angular/forms']).toContain(SCOPE['team/mfe-b']);
  });

  it('a tagged design system scopes its whole family for an incompatible consumer (no foreign Angular)', async () => {
    // @acme/ds is version-coupled to @angular/core and joins the pool via a `pool: "angular"` tag.
    // mfe-b runs Angular 18 (incompatible with the mfe-a@17 anchor), so it is incompatibility-forced
    // and scopes its ENTIRE family — including its own @acme/ds — with NO dedup. This is exactly what
    // prevents mfe-b from consuming mfe-a's shared ds (built against core@17) and ending up with two
    // Angulars (NG0203).
    const dsMeta = (remote: string) =>
      mockVersionRemote(remote, '@acme/ds', { requiredVersion: '^1.0.0', strictVersion: true, pool: 'angular' });
    seed('@angular/core', [
      version('17.0.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('18.0.0', '@angular/core', [{ remote: 'team/mfe-b', req: '^18.0.0' }]),
    ]);
    seed('@acme/ds', [
      { tag: '1.0.0', host: false, action: 'skip', remotes: [dsMeta('team/mfe-a')] },
      { tag: '1.0.0', host: false, action: 'skip', remotes: [dsMeta('team/mfe-b')] },
    ]);

    const importMap = await runInit();

    // Shared family (core + ds) is single-source on mfe-a.
    expect(importMap.imports['@angular/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@acme/ds']).toContain(SCOPE['team/mfe-a']);

    // mfe-b scopes its WHOLE family — ds is NOT deduped despite matching version 1.0.0, so no foreign
    // Angular leaks in through the shared design system.
    const bScope = importMap.scopes?.[SCOPE['team/mfe-b']];
    expect(bScope?.['@angular/core']).toContain(SCOPE['team/mfe-b']);
    expect(bScope?.['@acme/ds']).toContain(SCOPE['team/mfe-b']);
  });

  it('coverage-forced dedups a same-version member while incompatibility-forced scopes its whole family', async () => {
    // mfe-a is the anchor (core+common). mfe-b is coverage-forced (uses cdk, the orphan; core@17
    // matches). mfe-c is incompatibility-forced (core@18). End-to-end contrast through the import map.
    seed('@angular/core', [
      version('17.0.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.0.0', '@angular/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('18.0.0', '@angular/core', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);
    seed('@angular/common', [
      version('17.0.0', '@angular/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.0.0', '@angular/common', [{ remote: 'team/mfe-c', req: '^17.0.0' }]),
    ]);
    seed('@angular/cdk', [version('17.0.0', '@angular/cdk', [{ remote: 'team/mfe-b', req: '^17.0.0' }])]);

    const importMap = await runInit();

    // core: shared on mfe-a; mfe-b dedups (no scoped copy); mfe-c scopes (incompatible).
    expect(importMap.imports['@angular/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@angular/core']).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/mfe-c']]?.['@angular/core']).toContain(SCOPE['team/mfe-c']);

    // common: shared on mfe-a; mfe-c scopes it too (whole-family, no dedup) even at the same version.
    expect(importMap.imports['@angular/common']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.scopes?.[SCOPE['team/mfe-c']]?.['@angular/common']).toContain(SCOPE['team/mfe-c']);

    // cdk: orphan → scoped-only on mfe-b.
    expect(importMap.imports['@angular/cdk']).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@angular/cdk']).toContain(SCOPE['team/mfe-b']);
  });

  it('scopes a dynamically-added incompatible remote whole family (dynamic init path)', async () => {
    // Existing coherent anchor (mfe-a @17) already committed.
    const shareVersion = (external: string): SharedExternal => ({
      dirty: false,
      versions: [
        { tag: '17.0.0', host: false, action: 'share', remotes: [meta('team/mfe-a', external, '^17.0.0')] },
      ],
    });
    adapters.sharedExternalsRepo.addOrUpdate('@angular/core', shareVersion('@angular/core'), undefined);
    adapters.sharedExternalsRepo.addOrUpdate('@angular/common', shareVersion('@angular/common'), undefined);

    const entryC: RemoteEntry = {
      name: 'team/mfe-c',
      url: 'http://mfe-c/remoteEntry.json',
      exposes: [],
      shared: [
        mockSharedInfo('@angular/core', {
          requiredVersion: '^18.0.0',
          version: '18.0.0',
          singleton: true,
          strictVersion: true,
        }),
        mockSharedInfo('@angular/common', {
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
    expect(cScope?.['@angular/core']).toContain(SCOPE['team/mfe-c']);
    expect(cScope?.['@angular/common']).toContain(SCOPE['team/mfe-c']);
    expect(importMap.imports['@angular/core']).toBeUndefined();
    expect(importMap.imports['@angular/common']).toBeUndefined();
  });
});
