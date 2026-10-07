import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockVersionRemote, newestFirst } from 'lib/testing/domain/externals/version.mock';
import { Optional } from 'lib/utils/optional';
import type { RemoteInfo, SharedVersion } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createDetermineSharedExternals } from '../determine-shared-externals';
import { createMarkPoolsForReelection } from './mark-pools-for-reelection';
import { createPoolSharedExternals } from './pool-shared-externals';
import { createGenerateImportMap } from '../generate-import-map';
import { findIncoherentRemotes, findSplitRemotes } from 'lib/testing/pooling/no-tear';
import { tagStoredByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';

/**
 * Permanent regression guard for #63, end to end through determine → pooling → import map.
 *
 * Before the fix, pooling only islanded remotes the resolver had marked `scope`, so a monorepo family
 * whose members are each individually compatible could still be served from two builds at two versions
 * — `@angular/core` from one remote, `@angular/router` from another — and the remote consuming both ran
 * a mismatched framework family.
 *
 * Variant election closes it by construction: a pool elects whole builds, and a remote runs the elected
 * build only when it ships every entrypoint the remote imports at versions its `requiredVersion` accepts.
 * Otherwise it runs a later round's build or its own, taking the elected files only where it agrees with
 * them on everything both ship.
 *
 * The five things this file locks, in order: the two #63 repro cases are fixed, the second with the host
 * keeping its pin; patch drift runs on the one build covering both remotes; a previous-major member leaves
 * the shared set when its only provider runs its own build; and a clean subset consumer of an asymmetric
 * family is never islanded.
 */
describe('pooling: family coherence', () => {
  const SCOPE = {
    'team/host': 'http://host/',
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
    'team/legacy': 'http://legacy/',
  } as const;

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-family-coherence'),
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

  // Sorts like commit() does, so the fixtures below read in whatever order is clearest without
  // seeding an order production could never hand to determine.
  const seed = (name: string, versions: SharedVersion[]) =>
    adapters.sharedExternalsRepo.addOrUpdate(
      name,
      // The build tags every scoped package with its npm scope by default; `tagStoredByNpmScope` stands in.
      tagStoredByNpmScope({
        [name]: { dirty: true, versions: newestFirst(versions, adapters.versionCheck.compare) },
      })[name]!,
      undefined
    );

  // Every fixture in this file has to satisfy I3, so it is asserted here rather than test by test: no
  // non-host remote may resolve a combination of tags that no single build shipped. `team/host` is the
  // only exemption, since a host cannot be repointed onto another build.
  const runInit = async () => {
    const pooled = await createMarkPoolsForReelection(config, adapters)();
    const touched = await createDetermineSharedExternals(config, adapters)(pooled);
    await createPoolSharedExternals(config, adapters)(touched);
    const importMap = await createGenerateImportMap(config, adapters)();

    expect(
      findIncoherentRemotes({
        importMap,
        members: adapters.sharedExternalsRepo.getFromScope(undefined),
        scopeUrls: SCOPE,
        hosts: ['team/host'],
      })
    ).toEqual([]);
    // The second hop: no remote's import graph may reach a specifier at two tags.
    expect(
      findSplitRemotes({
        importMap,
        members: adapters.sharedExternalsRepo.getFromScope(undefined),
        scopeUrls: SCOPE,
        hosts: ['team/host'],
      })
    ).toEqual([]);

    return importMap;
  };

  it('islands the strict pinner rather than letting it drag one member down', async () => {
    // mfe-b pins core to ~22.0.5; mfe-a ships core + router at 22.1.0 and is the only router provider.
    // Under per-member election core resolved DOWN to mfe-b's 22.0.5 while router stayed on 22.1.0, and
    // mfe-a had to island. Electing the family: neither build serves the other remote, nobody agrees with
    // either, so the newer build wins round 1 and the pinner is the one that runs its own core.
    seed('@angular/core', [
      version('22.1.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      version('22.0.5', '@angular/core', [{ remote: 'team/mfe-b', req: '~22.0.5', strict: true }]),
    ]);
    seed('@angular/router', [
      version('22.1.0', '@angular/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
    ]);

    const importMap = await runInit();

    expect(importMap.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(importMap.imports['@angular/router']).toBe('http://mfe-a/@angular/router.js');
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]).toEqual({
      '@angular/core': 'http://mfe-b/@angular/core.js',
    });

    const core = adapters.sharedExternalsRepo.getFromScope(undefined)['@angular/core']!;
    expect(core.versions.map(v => `${v.tag}:${v.action}`)).toEqual([
      '22.1.0:share',
      '22.0.5:scope',
    ]);

    // One warning: the pinner, naming the elected tag its range rejects.
    expect(config.log.warn).toHaveBeenCalledWith(
      3,
      expect.stringContaining("'team/mfe-b' is islanded: its range rejects '@angular/core@22.1.0'")
    );
    expect(vi.mocked(config.log.warn).mock.calls).toHaveLength(1);
  });

  it('keeps the host tag and islands the remote that would mix builds', async () => {
    // The host ships core@22.0.5 → host precedence forces the shared core to 22.0.5. The host does
    // not ship router, so router resolves freely to 22.1.0 from mfe-a. Host precedence is untouched
    // by the gate: it is mfe-a that gives way, not the host's pin — so coherence and absolute host
    // priority are not in tension: coherence costs the mixing remote a dedup, never the host its pin.
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

  it('runs patch drift on the one build that covers both remotes', async () => {
    // Two remotes one patch apart, both ~21.2.0; mfe-a ships core + forms at 21.2.2, mfe-b only core at
    // 21.2.3. Per-member election put core on mfe-b's newer patch while forms stayed on mfe-a's build, so
    // mfe-a islanded (3 downloads). mfe-a's build serves both remotes, so the family runs it: older, but
    // coherent, and 2 downloads.
    seed('@angular/core', [
      version('21.2.2', '@angular/core', [{ remote: 'team/mfe-a', req: '~21.2.0' }]),
      version('21.2.3', '@angular/core', [{ remote: 'team/mfe-b', req: '~21.2.0' }]),
    ]);
    seed('@angular/forms', [
      version('21.2.2', '@angular/forms', [{ remote: 'team/mfe-a', req: '~21.2.0' }]),
    ]);

    const importMap = await runInit();

    expect(importMap.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(importMap.imports['@angular/forms']).toBe('http://mfe-a/@angular/forms.js');
    expect(importMap.scopes ?? {}).toEqual({});
    expect(config.log.warn).not.toHaveBeenCalled();
  });

  it('drops a previous-major member from the shared set when its only provider is islanded', async () => {
    // The production capture's failure. legacy pins ~21.2.0, which rejects the
    // 22 winner, so it is islanded on core — but it is also the SOLE provider of animations. Islanding
    // takes that copy with it, so animations leaves the shared set rather than staying globally shared
    // at 21.2.18 beside core@22.0.8. The mechanism is islanding plus rebuild stripping the last
    // provider, not election: nothing is ever re-pointed.
    seed('@angular/core', [
      version('22.0.8', '@angular/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      version('21.2.18', '@angular/core', [{ remote: 'team/legacy', req: '~21.2.0' }]),
    ]);
    seed('@angular/animations', [
      version('21.2.18', '@angular/animations', [{ remote: 'team/legacy', req: '~21.2.0' }]),
    ]);

    const importMap = await runInit();

    expect(importMap.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(importMap.imports['@angular/animations']).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/legacy']]).toEqual({
      '@angular/core': 'http://legacy/@angular/core.js',
      '@angular/animations': 'http://legacy/@angular/animations.js',
    });

    // What coherence means here: one major left in the shared set, and no package split across tags.
    const shared = Object.values(adapters.sharedExternalsRepo.getFromScope(undefined)).flatMap(e =>
      e.versions.filter(v => v.action === 'share').map(v => v.tag)
    );
    expect(new Set(shared.map(tag => tag.split('.')[0]))).toEqual(new Set(['22']));
  });

  it('never islands a clean subset consumer of an asymmetric family', async () => {
    // Asymmetric coverage: mfe-a ships {core, common, material}, mfe-b only {core, common}, one patch
    // apart and newer on different members. mfe-a's build serves mfe-b too (^17.0.0 takes either patch),
    // so the whole family is mfe-a's and the map needs no scope at all. The gate pipeline reached the
    // same 3 downloads through two scope entries, because it could not re-elect core onto 17.0.0.
    seed('@angular/core', [
      version('17.0.1', '@angular/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('17.0.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
    ]);
    seed('@angular/common', [
      version('17.0.1', '@angular/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.0.0', '@angular/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);
    seed('@angular/material', [
      version('17.0.1', '@angular/material', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
    ]);

    const importMap = await runInit();

    expect(importMap.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(importMap.imports['@angular/common']).toBe('http://mfe-a/@angular/common.js');
    expect(importMap.imports['@angular/material']).toBe('http://mfe-a/@angular/material.js');
    expect(importMap.scopes ?? {}).toEqual({});

    const scoped = Object.values(adapters.sharedExternalsRepo.getFromScope(undefined)).flatMap(e =>
      e.versions.filter(v => v.action === 'scope')
    );
    expect(scoped).toEqual([]);
    expect(config.log.warn).not.toHaveBeenCalled();
  });
});
