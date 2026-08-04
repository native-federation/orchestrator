import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockVersionRemote, newestFirst } from 'lib/testing/domain/externals/version.mock';
import { emittedUrls, findIncoherentRemotes } from 'lib/testing/pooling/no-tear';
import { Optional } from 'lib/utils/optional';
import type { RemoteInfo, SharedVersion } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createDetermineSharedExternals } from '../determine-shared-externals';
import { createPoolSharedExternals } from './pool-shared-externals';
import { createGenerateImportMap } from '../generate-import-map';

/**
 * Characterisation of `F-F-per-version-verdicts.md`: a verdict is written onto a whole `SharedVersion`,
 * but `requiredVersion` and `strictVersion` are per-build settings, so a row can hold copies that
 * disagree. When one copy rejects the winner and declared `strictVersion: true`, the row is marked
 * `scope` and every co-tagged copy is scoped with it — including copies whose own range accepts the
 * winner and which could simply dedup. Pooling then reads that verdict as an incompatibility and
 * islands those remotes across the whole family.
 *
 * These expectations record the defect, not the intent. Marked below, per test:
 *   INVERTS  — what fix (1) changes (scope membership, download count, the false warning).
 *   HOLDS    — what must be true before and after (the objector self-serves, and I3: no remote runs a
 *              combination of tags no build shipped).
 *
 * Both fixtures come from measurements in the browser on `943a3ea` and 2026-07-31 respectively; see the
 * doc's "Measured" sections. The second one only reproduces warm — cold, the objector's own tag wins the
 * election and nothing is dragged — so its committed copies are seeded `cached`.
 */
describe('pooling: per-copy verdicts (F-F)', () => {
  const SCOPE = {
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
    'team/mfe-c': 'http://mfe-c/',
    'team/mfe-d': 'http://mfe-d/',
    'team/mfe-x': 'http://mfe-x/',
    'team/mfe1': 'http://mfe1/',
    'team/mfe2': 'http://mfe2/',
    'team/mfe3': 'http://mfe3/',
  } as const;

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    config.feature.useAutoExternalPooling = true;

    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-per-copy-verdicts'),
      clearStorage: true,
    });

    adapters.remoteInfoRepo.getAll = vi.fn(() => ({}));
    adapters.scopedExternalsRepo.getAll = vi.fn(() => ({}));
    adapters.sharedChunksRepo.tryGet = vi.fn(() => Optional.empty<string[]>());
    adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
      name in SCOPE
        ? Optional.of({ scopeUrl: SCOPE[name as keyof typeof SCOPE], exposes: [] } as RemoteInfo)
        : Optional.empty<RemoteInfo>()
    );
  });

  const version = (
    tag: string,
    external: string,
    remotes: { remote: string; req: string; cached?: boolean }[]
  ): SharedVersion => ({
    tag,
    host: false,
    action: 'skip',
    remotes: remotes.map(r =>
      mockVersionRemote(r.remote, external, {
        requiredVersion: r.req,
        strictVersion: true,
        cached: r.cached ?? false,
      })
    ),
  });

  const seed = (name: string, versions: SharedVersion[]) =>
    adapters.sharedExternalsRepo.addOrUpdate(
      name,
      { dirty: true, versions: newestFirst(versions, adapters.versionCheck.compare) },
      undefined
    );

  const runInit = async () => {
    const touched = await createDetermineSharedExternals(config, adapters)();
    await createPoolSharedExternals(config, adapters)(touched);
    return createGenerateImportMap(config, adapters)();
  };

  const stored = () => adapters.sharedExternalsRepo.getFromScope(undefined);

  const rows = (external: string) =>
    stored()[external]!.versions.map(
      v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name).join(',')}]`
    );

  it('scopes a compatible co-tagged remote, then islands it across the family', async () => {
    // mfe-a and mfe-c both ship core@21.1.1; only mfe-c's `~21.1.1` rejects the 21.2.0 majority.
    // mfe-a's `^21.1.0` accepts it and could dedup.
    seed('@angular/core', [
      version('21.1.1', '@angular/core', [
        { remote: 'team/mfe-a', req: '^21.1.0' },
        { remote: 'team/mfe-c', req: '~21.1.1' },
      ]),
      version('21.2.0', '@angular/core', [
        { remote: 'team/mfe-b', req: '^21.2.0' },
        { remote: 'team/mfe-d', req: '^21.2.0' },
        { remote: 'team/mfe-x', req: '^21.2.0' },
      ]),
    ]);
    seed('@angular/common', [
      version('21.1.1', '@angular/common', [{ remote: 'team/mfe-a', req: '^21.1.0' }]),
      version('21.2.0', '@angular/common', [
        { remote: 'team/mfe-b', req: '^21.2.0' },
        { remote: 'team/mfe-d', req: '^21.2.0' },
        { remote: 'team/mfe-x', req: '^21.2.0' },
      ]),
    ]);

    const importMap = await runInit();

    // INVERTS: mfe-a belongs in a `skip` row of its own tag, not in mfe-c's `scope` row.
    expect(rows('@angular/core')).toEqual([
      '21.2.0:share:[team/mfe-b,team/mfe-d,team/mfe-x]',
      '21.1.1:scope:[team/mfe-a,team/mfe-c]',
    ]);

    // INVERTS: mfe-a's `common` dedup is collateral from gate 1 islanding it on `core`.
    expect(rows('@angular/common')).toEqual([
      '21.2.0:share:[team/mfe-b,team/mfe-d,team/mfe-x]',
      '21.1.1:scope:[team/mfe-a]',
    ]);

    // HOLDS: the majority is shared from one build, and mfe-c honours its own pin.
    expect(importMap.imports).toEqual({
      '@angular/core': 'http://mfe-b/@angular/core.js',
      '@angular/common': 'http://mfe-b/@angular/common.js',
    });
    expect(importMap.scopes?.[SCOPE['team/mfe-c']]).toEqual({
      '@angular/core': 'http://mfe-c/@angular/core.js',
    });

    // INVERTS: mfe-a downloads a whole family it is compatible with. 5 files where 3 are reachable.
    expect(importMap.scopes?.[SCOPE['team/mfe-a']]).toEqual({
      '@angular/core': 'http://mfe-a/@angular/core.js',
      '@angular/common': 'http://mfe-a/@angular/common.js',
    });
    expect(emittedUrls(importMap).size).toBe(5);

    // INVERTS: the claim is false — mfe-a's `^21.1.0` accepts 21.2.0. Only mfe-c is incompatible.
    expect(config.log.warn).toHaveBeenCalledWith(
      3,
      expect.stringContaining(
        "'team/mfe-a' is islanded: '@angular/core@21.1.1' is incompatible with the shared version"
      )
    );

    // HOLDS: islanding is over-broad but never incoherent — every remote's tags are ones one build shipped.
    expect(findIncoherentRemotes({ importMap, members: stored(), scopeUrls: SCOPE })).toEqual([]);
  });

  it('drags a co-tagged joiner that declares a wider range than the pinner', async () => {
    // mfe1 and mfe2 are already committed, so 22.1.0 wins on cost and mfe3 joins into mfe2's row.
    // mfe3 ships only `core`, so its "whole family" is one member: this instance separates fix (1)
    // from a gate-1-only fix, which would silence the warning but keep the download.
    seed('@angular/core', [
      version('22.1.0', '@angular/core', [{ remote: 'team/mfe1', req: '^22.0.0', cached: true }]),
      version('22.0.5', '@angular/core', [
        { remote: 'team/mfe2', req: '~22.0.5', cached: true },
        { remote: 'team/mfe3', req: '^22.0.0' },
      ]),
    ]);
    seed('@angular/router', [
      version('22.1.0', '@angular/router', [{ remote: 'team/mfe1', req: '^22.0.0', cached: true }]),
    ]);

    const importMap = await runInit();

    // INVERTS: mfe3 accepts 22.1.0 and sits in the pinner's row only because they share a tag.
    expect(rows('@angular/core')).toEqual([
      '22.1.0:share:[team/mfe1]',
      '22.0.5:scope:[team/mfe2,team/mfe3]',
    ]);

    // HOLDS: mfe2's pin is honoured from its own build.
    expect(importMap.scopes?.[SCOPE['team/mfe2']]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
    });

    // INVERTS: mfe3 downloads its own copy of a version it accepts. 4 files where 3 are reachable.
    expect(importMap.scopes?.[SCOPE['team/mfe3']]).toEqual({
      '@angular/core': 'http://mfe3/@angular/core.js',
    });
    expect(emittedUrls(importMap).size).toBe(4);

    // INVERTS: same false claim, against a range that accepts the winner.
    expect(config.log.warn).toHaveBeenCalledWith(
      3,
      expect.stringContaining(
        "'team/mfe3' is islanded: '@angular/core@22.0.5' is incompatible with the shared version"
      )
    );

    // HOLDS.
    expect(findIncoherentRemotes({ importMap, members: stored(), scopeUrls: SCOPE })).toEqual([]);
  });
});
