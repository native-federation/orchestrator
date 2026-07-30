import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { Optional } from 'lib/utils/optional';
import type { RemoteInfo, SharedVersion } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createDetermineSharedExternals } from '../determine-shared-externals';
import { createPoolSharedExternals } from './pool-shared-externals';
import { createGenerateImportMap } from '../generate-import-map';

/**
 * KNOWN BUG (regression from the island-or-defer rework, PR #56): pooling only islands remotes the
 * resolver marked `scope`. It never aligns the per-member WINNERS, so a monorepo family whose members
 * are individually compatible can still be served from two different builds at two different
 * versions — `@angular/core` from one remote, `@angular/router` from another. A remote that consumes
 * both then runs a mismatched framework family.
 *
 * These specs assert the CURRENT (incorrect) behaviour so the regression is documented; they must be
 * inverted once pooling aligns a family onto one serving build.
 */
describe('pooling: split monorepo family (known bug)', () => {
  const SCOPE = {
    'team/host': 'http://host/',
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
  } as const;

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    config.feature.useAutoExternalPooling = true;

    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-split-repro'),
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

  const version = (
    tag: string,
    external: string,
    remotes: { remote: string; req: string; strict?: boolean; host?: boolean }[]
  ): SharedVersion => ({
    tag,
    host: remotes.some(r => r.host),
    action: 'skip',
    remotes: remotes.map(r =>
      mockVersionRemote(r.remote, external, {
        requiredVersion: r.req,
        strictVersion: r.strict ?? true,
      })
    ),
  });

  const seed = (name: string, versions: SharedVersion[]) =>
    adapters.sharedExternalsRepo.addOrUpdate(name, { dirty: true, versions }, undefined);

  const runInit = async () => {
    await createDetermineSharedExternals(config, adapters)();
    await createPoolSharedExternals(config, adapters)();
    return createGenerateImportMap(config, adapters)();
  };

  it('serves the whole family from one build when a strict pin cannot follow it', async () => {
    // determine resolves core DOWN to 22.0.5 (mfe-b's build, one fewer download) while router has no
    // such pin and only mfe-a provides it — a split family. Election re-points core onto mfe-a's
    // instance, the only one that serves a remote's whole consumption, and mfe-b then islands.
    seed('@angular/core', [
      version('22.1.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      version('22.0.5', '@angular/core', [{ remote: 'team/mfe-b', req: '~22.0.5', strict: true }]),
    ]);
    seed('@angular/router', [
      version('22.1.0', '@angular/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
    ]);

    const importMap = await runInit();

    // One build serves both members.
    expect(importMap.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(importMap.imports['@angular/router']).toBe('http://mfe-a/@angular/router.js');

    // mfe-b's ~22.0.5 rejects 22.1.0, so it self-serves its whole family instead of mixing builds.
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@angular/core']).toBe(
      'http://mfe-b/@angular/core.js'
    );

    const core = adapters.sharedExternalsRepo.getFromScope(undefined)['@angular/core']!;
    expect(core.versions.map(v => `${v.tag}:${v.action}`)).toEqual([
      '22.1.0:share',
      '22.0.5:scope',
    ]);
  });

  it('splits the family when host precedence pins one member', async () => {
    // The host ships core@22.0.5 → host precedence forces the shared core to 22.0.5. The host does
    // not ship router, so router resolves freely to 22.1.0 from mfe-a.
    seed('@angular/core', [
      version('22.1.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      version('22.0.5', '@angular/core', [{ remote: 'team/host', req: '^22.0.0', host: true }]),
    ]);
    seed('@angular/router', [
      version('22.1.0', '@angular/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
    ]);

    const importMap = await runInit();

    // BUG: host's core@22.0.5 + mfe-a's router@22.1.0 are shared side by side.
    expect(importMap.imports['@angular/core']).toBe('http://host/@angular/core.js');
    expect(importMap.imports['@angular/router']).toBe('http://mfe-a/@angular/router.js');
    expect(importMap.scopes?.[SCOPE['team/mfe-a']]?.['@angular/core']).toBeUndefined();
  });
});
