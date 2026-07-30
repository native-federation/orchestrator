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
 * Regression guard for #63. Before the fix, pooling only islanded remotes the resolver had marked
 * `scope`, so a monorepo family whose members are each individually compatible could still be served
 * from two builds at two versions — `@angular/core` from one remote, `@angular/router` from another —
 * and the remote consuming both ran a mismatched framework family.
 *
 * The agreement gate closes it: a remote may draw on several builds (patch drift inside a family is
 * normal) but not on builds that disagree, i.e. that place a member they both ship on a different
 * minor line. Such a remote serves its whole family from its own build instead.
 */
describe('pooling: split monorepo family', () => {
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
    const touched = await createDetermineSharedExternals(config, adapters)();
    await createPoolSharedExternals(config, adapters)(touched);
    return createGenerateImportMap(config, adapters)();
  };

  it('islands the remote that would mix builds when a strict pin drags one member down', async () => {
    // mfe-b pins core to ~22.0.5, so core resolves DOWN to 22.0.5 (mfe-b's build). router carries no
    // such pin and only mfe-a provides it, so it resolves to 22.1.0 (mfe-a's build) — leaving mfe-a
    // drawing core from mfe-b and router from itself, across a minor line.
    seed('@angular/core', [
      version('22.1.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      version('22.0.5', '@angular/core', [{ remote: 'team/mfe-b', req: '~22.0.5', strict: true }]),
    ]);
    seed('@angular/router', [
      version('22.1.0', '@angular/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
    ]);

    const importMap = await runInit();

    // core stays shared for mfe-b, which is the only remote that can still use it.
    expect(importMap.imports['@angular/core']).toBe('http://mfe-b/@angular/core.js');

    // mfe-a serves its whole family from its own build rather than mixing 22.0.5 with 22.1.0.
    expect(importMap.scopes?.[SCOPE['team/mfe-a']]).toEqual({
      '@angular/core': 'http://mfe-a/@angular/core.js',
      '@angular/router': 'http://mfe-a/@angular/router.js',
    });

    // router had no other provider, so it is not shared at all any more.
    expect(importMap.imports['@angular/router']).toBeUndefined();

    const core = adapters.sharedExternalsRepo.getFromScope(undefined)['@angular/core']!;
    expect(core.versions.map(v => `${v.tag}:${v.action}`).sort()).toEqual([
      '22.0.5:share',
      '22.1.0:scope',
    ]);
  });

  it('keeps the host tag and islands the remote that would mix builds', async () => {
    // The host ships core@22.0.5 → host precedence forces the shared core to 22.0.5. The host does
    // not ship router, so router resolves freely to 22.1.0 from mfe-a. Host precedence is untouched
    // by the gate: it is mfe-a that gives way, not the host's pin.
    seed('@angular/core', [
      version('22.1.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      version('22.0.5', '@angular/core', [{ remote: 'team/host', req: '^22.0.0', host: true }]),
    ]);
    seed('@angular/router', [
      version('22.1.0', '@angular/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
    ]);

    const importMap = await runInit();

    expect(importMap.imports['@angular/core']).toBe('http://host/@angular/core.js');
    expect(importMap.imports['@angular/router']).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/mfe-a']]).toEqual({
      '@angular/core': 'http://mfe-a/@angular/core.js',
      '@angular/router': 'http://mfe-a/@angular/router.js',
    });
  });
});
