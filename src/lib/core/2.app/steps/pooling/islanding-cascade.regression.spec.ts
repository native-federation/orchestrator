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

/**
 * Follow-up **F-A**, the islanding cascade: adding one previous-major remote to a healthy portfolio
 * used to island remotes that were perfectly compatible with each other. On the production capture it
 * took 7 remotes from 36 to 64 downloads and islanded 5 of 8, three of them healthy Angular-22 remotes.
 *
 * The cause was never pooling's agreement gate — it fires on none of this — but `determine`'s
 * extra-download objective, which counted **versions rather than remote copies**. Two patch-drifted
 * legacy remotes on two distinct tags therefore outvoted three modern remotes that all agreed on one
 * tag; `@angular/router`'s winner moved to the 21 line, the modern remotes' `router@22.0.8` became
 * strictly incompatible, and pooling amplified that single member's mis-election into the whole family.
 *
 * A scoped version serves every one of its remotes from its own build, so it costs one download per
 * uncached copy. Weighting the objective that way is what these tests lock: it is the same objective
 * the docs always claimed (fewest extra downloads), counted in the right unit.
 *
 * What it does NOT fix is the second describe below: the election is still per external, so members of
 * one pool can elect opposite lines. See `F-A-islanding-cascade.md`.
 */
describe('pooling: islanding cascade (F-A)', () => {
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

  // Sorts like commit() does, so the fixtures below read in whatever order is clearest without
  // seeding an order production could never hand to determine.
  const seed = (name: string, versions: SharedVersion[]) =>
    adapters.sharedExternalsRepo.addOrUpdate(
      name,
      { dirty: true, versions: newestFirst(versions, adapters.versionCheck.compare) },
      undefined
    );

  const runInit = async () => {
    const touched = await createDetermineSharedExternals(config, adapters)();
    await createPoolSharedExternals(config, adapters)(touched);
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

  const winner = (member: string) =>
    adapters.sharedExternalsRepo
      .getFromScope(undefined)[member]!.versions.find(v => v.action === 'share')?.tag;

  const islandedRemotes = () =>
    vi
      .mocked(config.log.warn)
      .mock.calls.map(c => /'([^']+)' is islanded: '([^']+)'/.exec(String(c[1])))
      .filter(m => m !== null)
      .map(m => `${m![1]} on ${m![2]}`)
      .sort();

  describe('a previous-major minority does not island the majority', () => {
    // The Angular-22 majority: mfe-a and mfe-b ship core + router at 22.0.8, mfe-c only core, one
    // patch behind. `legacy` is the previous-major remote(s), honestly pinned to their own minor line.
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
        ...legacy.map(l =>
          version(l.tag, '@angular/router', [{ remote: l.remote, req: '~21.2.0' }])
        ),
      ]);
    };

    it('shares the whole family with one previous-major remote present', async () => {
      seedPortfolio([{ remote: 'team/legacy-a', tag: '21.2.18' }]);

      await runInit();

      expect(winner('@angular/core')).toBe('22.0.8');
      expect(winner('@angular/router')).toBe('22.0.8');
      expect(islandedRemotes()).toEqual(['team/legacy-a on @angular/core@21.2.18']);
      expect(downloads()).toBe(4);
    });

    it('holds when a second previous-major remote joins on its own patch tag', async () => {
      // legacy-b adds a SECOND distinct 21 tag and nothing else; it conflicts with nobody. Counting
      // scoped versions, `router@22.0.8` cost 2 against each 21 version's 1, so the winner moved to
      // the 21 line and islanded mfe-a and mfe-b across their whole family. Counting copies, both
      // sides cost 2 and the newest tag keeps it.
      seedPortfolio([
        { remote: 'team/legacy-a', tag: '21.2.18' },
        { remote: 'team/legacy-b', tag: '21.2.15' },
      ]);

      await runInit();

      expect(winner('@angular/core')).toBe('22.0.8');
      expect(winner('@angular/router')).toBe('22.0.8');

      // Only the two genuinely cross-major remotes island, and each on a real range violation.
      expect(islandedRemotes()).toEqual([
        'team/legacy-a on @angular/core@21.2.18',
        'team/legacy-b on @angular/core@21.2.15',
      ]);
      expect(config.log.warn).not.toHaveBeenCalledWith(3, expect.stringContaining('disagree on'));

      // mfe-c islanded nothing and keeps deduping core; only the two legacy copies self-serve.
      const stored = adapters.sharedExternalsRepo.getFromScope(undefined);
      expect(
        stored['@angular/core']!.versions.some(
          v => v.action === 'scope' && v.remotes.some(r => r.name === 'team/mfe-c')
        )
      ).toBe(false);

      // 4 downloads with one legacy remote, 6 with two — the honest price of two islands, not 9.
      expect(downloads()).toBe(6);
    });
  });

  /**
   * CHARACTERISATION of what remains open: the objective is exact per external, but it is still
   * evaluated per external. When two members of one pool have their remote-count majority on opposite
   * lines they elect opposite winners, and pooling amplifies the split. A failure here is probably
   * good news — re-read `F-A-islanding-cascade.md` before "repairing" it.
   */
  describe('residual: per-member elections can still disagree across a pool', () => {
    it('splits a family when each member has its majority on a different line', async () => {
      // core's modern side is larger, router's legacy side is larger.
      seed('@angular/core', [
        version('22.0.8', '@angular/core', [
          { remote: 'team/mfe-a', req: '~22.0.3' },
          { remote: 'team/mfe-b', req: '~22.0.3' },
          { remote: 'team/mfe-c', req: '~22.0.3' },
        ]),
        version('21.2.18', '@angular/core', [{ remote: 'team/legacy-a', req: '~21.2.0' }]),
      ]);
      seed('@angular/router', [
        version('22.0.8', '@angular/router', [{ remote: 'team/mfe-a', req: '~22.0.3' }]),
        version('21.2.18', '@angular/router', [
          { remote: 'team/legacy-a', req: '~21.2.0' },
          { remote: 'team/legacy-b', req: '~21.2.0' },
        ]),
      ]);

      await runInit();

      // Each winner is the cheaper one for its own member, and together they cost mfe-a its family.
      expect(winner('@angular/core')).toBe('22.0.8');
      expect(winner('@angular/router')).toBe('21.2.18');
      expect(islandedRemotes()).toEqual([
        'team/legacy-a on @angular/core@21.2.18',
        'team/mfe-a on @angular/router@22.0.8',
      ]);
      expect(downloads()).toBe(6);
    });
  });
});
