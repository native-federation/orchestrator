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

/**
 * CHARACTERISATION, not a specification: this file asserts a known deficiency — follow-up **F-A**,
 * `research.md` §16.2 — so that fixing it shows up as a deliberate change rather than a surprise diff.
 * If these expectations start failing, that is probably good news; re-read §16.2 before "repairing" them.
 *
 * The shape: adding ONE remote on the previous major to a healthy portfolio islands remotes that are
 * perfectly compatible with each other. Measured on the real capture it takes 7 remotes from 36 to 64
 * downloads and islands 5 of 8, three of them healthy Angular-22 remotes.
 *
 * The mechanism is NOT pooling's agreement gate (it fires on none of this) but `determine`'s
 * extra-download objective, which counts **versions, not remotes**
 * (`determine-shared-externals.ts:122-126`): two patch-drifted legacy remotes on two distinct tags
 * outvote three modern remotes that all agree on one tag. `@angular/router`'s winner therefore moves to
 * the 21 line, the modern remotes' `router@22.0.8` becomes strictly incompatible, and pooling amplifies
 * that single member's mis-election into the whole family (all-or-nothing islanding, by design).
 *
 * Pooling cannot fix it: it is structurally subtractive — it can only withdraw dedups `determine`
 * granted, never restore one. Any fix belongs in the resolver's cost model, which is its own issue.
 */
describe('pooling: islanding cascade (F-A characterisation)', () => {
  const SCOPE = {
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
    'team/mfe-c': 'http://mfe-c/',
    'team/legacy-a': 'http://legacy-a/',
    'team/legacy-b': 'http://legacy-b/',
  } as const;

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    config.feature.useAutoExternalPooling = true;

    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-cascade'),
      clearStorage: true,
    });
    adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
      name in SCOPE
        ? Optional.of({ scopeUrl: SCOPE[name as keyof typeof SCOPE], exposes: [] } as RemoteInfo)
        : Optional.empty<RemoteInfo>()
    );
  });

  const version = (
    tag: string,
    external: string,
    remotes: { remote: string; req: string }[]
  ): SharedVersion => ({
    tag,
    host: false,
    action: 'skip',
    remotes: remotes.map(r =>
      mockVersionRemote(r.remote, external, { requiredVersion: r.req, strictVersion: true })
    ),
  });

  const seed = (name: string, versions: SharedVersion[]) =>
    adapters.sharedExternalsRepo.addOrUpdate(name, { dirty: true, versions }, undefined);

  const runInit = async () => {
    const touched = await createDetermineSharedExternals(config, adapters)();
    await createPoolSharedExternals(config, adapters)(touched);
  };

  // The Angular-22 majority: mfe-a and mfe-b ship core + router at 22.0.8, mfe-c only core, one patch
  // behind. `legacy` is the previous-major remote(s), honestly pinned to their own minor line.
  const seedPortfolio = (legacy: { remote: string; tag: string }[]) => {
    seed('@angular/core', [
      version('22.0.8', '@angular/core', [
        { remote: 'team/mfe-a', req: '~22.0.3' },
        { remote: 'team/mfe-b', req: '~22.0.3' },
      ]),
      version('22.0.6', '@angular/core', [{ remote: 'team/mfe-c', req: '~22.0.5' }]),
      ...legacy.map(l => version(l.tag, '@angular/core', [{ remote: l.remote, req: '~21.2.0' }])),
    ]);
    seed('@angular/router', [
      version('22.0.8', '@angular/router', [
        { remote: 'team/mfe-a', req: '~22.0.3' },
        { remote: 'team/mfe-b', req: '~22.0.3' },
      ]),
      ...legacy.map(l => version(l.tag, '@angular/router', [{ remote: l.remote, req: '~21.2.0' }])),
    ]);
  };

  // Downloads for the pool: one per shared member, plus one per remote that self-serves a copy.
  const downloads = () =>
    Object.values(adapters.sharedExternalsRepo.getFromScope(undefined)).reduce(
      (sum, external) =>
        sum +
        external.versions.reduce(
          (n, v) => n + (v.action === 'share' ? 1 : v.action === 'scope' ? v.remotes.length : 0),
          0
        ),
      0
    );

  const islandedRemotes = () =>
    vi
      .mocked(config.log.warn)
      .mock.calls.map(c => /'([^']+)' is islanded: '([^']+)'/.exec(String(c[1])))
      .filter(m => m !== null)
      .map(m => `${m![1]} on ${m![2]}`)
      .sort();

  it('shares the whole family with one previous-major remote present', async () => {
    // Baseline. legacy-a is the only 21 remote, so `router`'s two candidate versions tie on extra
    // downloads and the newest wins: the 22 majority keeps sharing both members and only legacy-a,
    // genuinely incompatible, scopes its family.
    seedPortfolio([{ remote: 'team/legacy-a', tag: '21.2.18' }]);

    await runInit();

    const stored = adapters.sharedExternalsRepo.getFromScope(undefined);
    expect(stored['@angular/core']!.versions.find(v => v.action === 'share')?.tag).toBe('22.0.8');
    expect(stored['@angular/router']!.versions.find(v => v.action === 'share')?.tag).toBe('22.0.8');
    expect(islandedRemotes()).toEqual(['team/legacy-a on @angular/core@21.2.18']);
    expect(downloads()).toBe(4);
  });

  it('islands the healthy majority when a second previous-major remote joins (F-A)', async () => {
    // legacy-b adds a SECOND distinct 21 tag and nothing else. It is not even in conflict with
    // legacy-a. Yet `router@22.0.8` now costs 2 extra downloads against each 21 version's 1, so the
    // winner moves to 21.2.18 — and mfe-a and mfe-b, which agree with each other perfectly, are
    // islanded across their whole family on a member they were happily sharing.
    seedPortfolio([
      { remote: 'team/legacy-a', tag: '21.2.18' },
      { remote: 'team/legacy-b', tag: '21.2.15' },
    ]);

    await runInit();

    expect(islandedRemotes()).toEqual([
      'team/legacy-a on @angular/core@21.2.18',
      'team/legacy-b on @angular/core@21.2.15',
      'team/mfe-a on @angular/router@22.0.8',
      'team/mfe-b on @angular/router@22.0.8',
    ]);

    // Every island is a range incompatibility (gate 1). The agreement gate fires on nothing here —
    // consistent with §16.1 finding 2, it fires on no real portfolio either.
    expect(config.log.warn).not.toHaveBeenCalledWith(3, expect.stringContaining('disagree on'));

    // Both members lose their shared version outright: router's elected 21.2.18 provider is islanded,
    // and core's 22.0.8 basis remotes are islanded by router. So mfe-c, which islanded nothing and was
    // deduping core happily, ends up self-serving too — the cascade's last step.
    const stored = adapters.sharedExternalsRepo.getFromScope(undefined);
    expect(stored['@angular/core']!.versions.some(v => v.action === 'share')).toBe(false);
    expect(stored['@angular/router']!.versions.some(v => v.action === 'share')).toBe(false);
    expect(
      stored['@angular/core']!.versions.some(
        v => v.action === 'scope' && v.remotes.some(r => r.name === 'team/mfe-c')
      )
    ).toBe(true);

    // 4 downloads with one legacy remote, 9 with two: F-A's cost, on a 5-remote portfolio.
    expect(downloads()).toBe(9);
  });
});
