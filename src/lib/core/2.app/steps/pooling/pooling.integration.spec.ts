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
    // Two coherent builds. Left to determine-shared-externals alone, core would anchor on mfe-a
    // (its version listed first) and common on mfe-b — an incoherent split. Pooling must unify them.
    seed('@angular/core', [
      version('17.0.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@angular/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);
    seed('@angular/common', [
      version('17.1.0', '@angular/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('17.0.0', '@angular/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
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
      version('17.1.0', '@angular/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('17.0.0', '@angular/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
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
