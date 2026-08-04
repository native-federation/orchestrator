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
import { createPoolSharedExternals } from './pool-shared-externals';
import { createGenerateImportMap } from '../generate-import-map';
import { findIncoherentRemotes } from 'lib/testing/pooling/no-tear';

/**
 * Permanent regression guard for #63, end to end through determine → pooling → import map.
 *
 * Before the fix, pooling only islanded remotes the resolver had marked `scope`, so a monorepo family
 * whose members are each individually compatible could still be served from two builds at two versions
 * — `@angular/core` from one remote, `@angular/router` from another — and the remote consuming both ran
 * a mismatched framework family.
 *
 * The coverage rule closes it, and reads no tag distance at all: a remote may dedup only onto a build
 * that offers **every** entrypoint it imports, at versions its own `requiredVersion` accepts — or, the
 * witness, when the map already serves all of them at exactly the tags some build shipped together.
 * Failing both it serves its whole family from its own build.
 *
 * The five things this file locks, in order: the two #63 repro cases are fixed, the second of them with
 * the host keeping its pin; patch drift across two builds is islanded, where the agreement gate this
 * replaced tolerated it as benign; a previous-major member leaves the shared set when its only provider is
 * islanded; and a clean subset consumer of an asymmetric family is never islanded.
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
    config.feature.useAutoExternalPooling = true;

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
      { dirty: true, versions: newestFirst(versions, adapters.versionCheck.compare) },
      undefined
    );

  // Every fixture in this file has to satisfy I3, so it is asserted here rather than test by test: no
  // non-host remote may resolve a combination of tags that no single build shipped. `team/host` is the
  // only exemption, since a host cannot be repointed onto another build.
  const runInit = async () => {
    const touched = await createDetermineSharedExternals(config, adapters)();
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

    return importMap;
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

    // The island is `warn`, names the member coverage broke on, and is the ONLY warning: router losing
    // its last provider is that island's own effect, so `warnIfScopedOnly` must not restate it.
    expect(config.log.warn).toHaveBeenCalledWith(
      3,
      expect.stringContaining(
        "'team/mfe-a' serves its own family: no shared build offers every entrypoint it imports at a version it accepts — '@angular/router' is the gap"
      )
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

  it('islands patch drift across two builds, which the old gate tolerated', async () => {
    // Rewritten deliberately for the provenance promise. Two remotes one patch apart, both declaring
    // ~21.2.0. core goes to mfe-b's newer patch, while forms has no provider but mfe-a and stays on its
    // build — so mfe-a would draw from two builds.
    //
    // What the old promise allowed: 21.2.2 beside 21.2.3 sit on the same minor line, so the two builds
    // "agreed" and mfe-a kept deduping core. What the new one requires: no build ever shipped
    // core@21.2.3 beside forms@21.2.2, and minor lines are not read at all, so mfe-a serves its own
    // family. Cost: 2 downloads before, 3 after — and forms, which only mfe-a provided, leaves the
    // shared set with it.
    //
    // The drift has to come from coverage asymmetry, not tag order: with both members provided by both
    // remotes, one build would simply win the whole family. Same shape as `tolerates patch drift when
    // each remote solely provides a member` in `e2e/pooling/asymmetric.e2e.spec.ts`.
    seed('@angular/core', [
      version('21.2.2', '@angular/core', [{ remote: 'team/mfe-a', req: '~21.2.0' }]),
      version('21.2.3', '@angular/core', [{ remote: 'team/mfe-b', req: '~21.2.0' }]),
    ]);
    seed('@angular/forms', [
      version('21.2.2', '@angular/forms', [{ remote: 'team/mfe-a', req: '~21.2.0' }]),
    ]);

    const importMap = await runInit();

    expect(importMap.imports['@angular/core']).toBe('http://mfe-b/@angular/core.js');
    expect(importMap.imports['@angular/forms']).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/mfe-a']]).toEqual({
      '@angular/core': 'http://mfe-a/@angular/core.js',
      '@angular/forms': 'http://mfe-a/@angular/forms.js',
    });

    expect(config.log.warn).toHaveBeenCalledWith(
      3,
      expect.stringContaining("'team/mfe-a' serves its own family")
    );
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
    // apart — and they hold the newer patch on different members, which is what splits the winners
    // across both builds: mfe-a self-serves common and material while deduping core from mfe-b. Every
    // build agrees at minor granularity, so neither remote is islanded and material stays shared — the
    // regression this locks is gratuitous scoping (I3), which the old single-build-per-remote rule
    // would have caused for mfe-a.
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

    // Both remotes end up on mfe-a's build, explicitly. What the old promise allowed: mfe-a deduped
    // core@17.0.1 from mfe-b while running its own common@17.0.1 — every build agreed at minor
    // granularity, so nothing was scoped and core stayed globally mapped. What the new one requires: one
    // build per remote, and mfe-a's is the only one covering both, so mfe-b takes core from it too.
    // Cost is unchanged at 3 downloads; what changed is that the family is coherent for both of them.
    //
    // core keeps no global mapping: its elected copy is mfe-b's, mfe-b now runs mfe-a's, and a basis that
    // does not run its own file may not publish it (constraint 17). Both consumers name mfe-a's file
    // instead — which is where a build-electing substrate would re-elect core onto 17.0.1's older
    // sibling and drop both scope entries. See §"The provenance promise", the election bullet.
    expect(importMap.imports['@angular/core']).toBeUndefined();
    expect(importMap.imports['@angular/common']).toBe('http://mfe-a/@angular/common.js');
    expect(importMap.imports['@angular/material']).toBe('http://mfe-a/@angular/material.js');
    expect(importMap.scopes).toEqual({
      'http://mfe-a/': { '@angular/core': 'http://mfe-a/@angular/core.js' },
      'http://mfe-b/': { '@angular/core': 'http://mfe-a/@angular/core.js' },
    });

    // Nothing is islanded: no copy is scoped, and the dedup is explicit rather than lost.
    const scoped = Object.values(adapters.sharedExternalsRepo.getFromScope(undefined)).flatMap(e =>
      e.versions.filter(v => v.action === 'scope')
    );
    expect(scoped).toEqual([]);
    expect(config.log.warn).not.toHaveBeenCalled();
  });
});
