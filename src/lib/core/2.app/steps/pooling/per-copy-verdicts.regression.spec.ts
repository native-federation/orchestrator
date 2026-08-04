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
 * Permanent guard for `F-F-per-version-verdicts.md`: a verdict belongs to the copy that objected, not to
 * the whole `SharedVersion`. `requiredVersion` and `strictVersion` are per-build settings, so one row can
 * hold copies that disagree; before the fix a single strict objector marked the row `scope` and every
 * co-tagged copy was scoped with it, whereupon gate 1 islanded those remotes across the whole family.
 *
 * Compatibility is still asked of the row as a whole — one version is one file served from one basis, so
 * redirecting it has to satisfy everyone it would redirect. Only the write-back is per copy.
 *
 * Both fixtures were measured in the browser on `943a3ea` and 2026-07-31; see the doc's "Measured"
 * sections for the pre-fix numbers (5 and 4 emitted URLs) these now improve on. The second one only
 * reproduces warm — cold, the objector's own tag wins the election and nothing is dragged — so its
 * committed copies are seeded `cached`.
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

  it('keeps a compatible co-tagged remote deduping when its neighbour objects', async () => {
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

    // The verdict follows the copy: mfe-a keeps its own tag in a `skip` row of its own, mfe-c alone
    // scopes. Both rows stay at 21.1.1 and stay adjacent, so the record is still newest-first.
    expect(rows('@angular/core')).toEqual([
      '21.2.0:share:[team/mfe-b,team/mfe-d,team/mfe-x]',
      '21.1.1:skip:[team/mfe-a]',
      '21.1.1:scope:[team/mfe-c]',
    ]);

    // Nothing islands mfe-a any more, so its `common` dedup survives.
    expect(rows('@angular/common')).toEqual([
      '21.2.0:share:[team/mfe-b,team/mfe-d,team/mfe-x]',
      '21.1.1:skip:[team/mfe-a]',
    ]);

    // The majority is shared from one build, and mfe-c honours its own pin.
    expect(importMap.imports).toEqual({
      '@angular/core': 'http://mfe-b/@angular/core.js',
      '@angular/common': 'http://mfe-b/@angular/common.js',
    });
    expect(importMap.scopes?.[SCOPE['team/mfe-c']]).toEqual({
      '@angular/core': 'http://mfe-c/@angular/core.js',
    });

    // mfe-a resolves both members through `imports`, i.e. from mfe-b's build — 3 files, the reachable
    // minimum, down from the 5 measured in the browser.
    expect(importMap.scopes?.[SCOPE['team/mfe-a']]).toBeUndefined();
    expect(emittedUrls(importMap).size).toBe(3);

    // No warning may name mfe-a: its `^21.1.0` accepts 21.2.0, so there was never an incompatibility
    // to report. mfe-c is not islanded either — it is the only copy of a `scope` row, which is the
    // ordinary per-external outcome and needs no pooling verdict at all.
    expect(config.log.warn).not.toHaveBeenCalledWith(
      3,
      expect.stringContaining("'team/mfe-a' is islanded")
    );

    // I3: every remote's resolved tags are ones a single build shipped. mfe-a takes core@21.2.0 and
    // common@21.2.0, which is mfe-b's build; mfe-c runs its own 21.1.1.
    expect(findIncoherentRemotes({ importMap, members: stored(), scopeUrls: SCOPE })).toEqual([]);
  });

  it("shares the pinner's tag with a co-tagged joiner that accepts the winner", async () => {
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

    // Only the pinner scopes; mfe3 leaves its row and dedups.
    expect(rows('@angular/core')).toEqual([
      '22.1.0:share:[team/mfe1]',
      '22.0.5:skip:[team/mfe3]',
      '22.0.5:scope:[team/mfe2]',
    ]);

    // mfe2's pin is honoured from its own build.
    expect(importMap.scopes?.[SCOPE['team/mfe2']]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
    });

    // This is the instance a gate-1-only fix could not recover: mfe3's copy sat inside a `scope` row, so
    // it kept downloading its own build even once pooling stopped islanding it. 3 files, matching a cold
    // resolution of the same three remotes.
    expect(importMap.scopes?.[SCOPE['team/mfe3']]).toBeUndefined();
    expect(emittedUrls(importMap).size).toBe(3);

    expect(config.log.warn).not.toHaveBeenCalledWith(
      3,
      expect.stringContaining("'team/mfe3' is islanded")
    );

    // I3: mfe3 runs core@22.1.0, which is mfe1's build.
    expect(findIncoherentRemotes({ importMap, members: stored(), scopeUrls: SCOPE })).toEqual([]);
  });
});
