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
import { tagStoredByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';

/**
 * **The islanding cascade**: adding one previous-major remote to a healthy portfolio
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
 * one pool can elect opposite lines — see `docs/version-resolver.md` §"3. Optimal Version Strategy",
 * "Known limitation".
 */
describe('pooling: islanding cascade', () => {
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
      // The build tags every scoped package with its npm scope by default; `tagStoredByNpmScope` stands in.
      tagStoredByNpmScope({
        [name]: { dirty: true, versions: newestFirst(versions, adapters.versionCheck.compare) },
      })[name]!,
      undefined
    );

  const runInit = async () => {
    const pooled = await createMarkPoolsForReelection(config, adapters)();
    const touched = await createDetermineSharedExternals(config, adapters)(pooled);
    await createPoolSharedExternals(config, adapters)(touched);
  };

  // Downloads for the pool: one per shared member, plus one per copy a remote runs from its own build —
  // scoped, or a subpool build's (`servedBy` naming itself), which its subpool dedups onto.
  const downloads = () =>
    Object.values(adapters.sharedExternalsRepo.getFromScope(undefined)).reduce(
      (sum, external) =>
        sum +
        external.versions.reduce(
          (n, v) =>
            n +
            (v.action === 'share'
              ? 1
              : v.action === 'scope'
                ? v.remotes.length
                : v.remotes.filter(r => r.servedBy === r.name).length),
          0
        ),
      0
    );

  const winner = (member: string) =>
    adapters.sharedExternalsRepo
      .getFromScope(undefined)
      [member]!.versions.find(v => v.action === 'share')?.tag;

  const islandedRemotes = () =>
    vi
      .mocked(config.log.warn)
      .mock.calls.map(c => /'([^']+)' is islanded: .*?'([^']+)'/.exec(String(c[1])))
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
      // The warning names the elected tag the remote's range rejects, not the remote's own tag.
      expect(islandedRemotes()).toEqual(['team/legacy-a on @angular/core@22.0.8']);
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
        'team/legacy-a on @angular/core@22.0.8',
        'team/legacy-b on @angular/core@22.0.8',
      ]);
      expect(config.log.warn).not.toHaveBeenCalledWith(3, expect.stringContaining('disagree on'));

      // mfe-c islanded nothing and keeps deduping core; only the two legacy copies self-serve.
      const stored = adapters.sharedExternalsRepo.getFromScope(undefined);
      expect(
        stored['@angular/core']!.versions.some(
          v => v.action === 'scope' && v.remotes.some(r => r.name === 'team/mfe-c')
        )
      ).toBe(false);

      // 4 downloads with one legacy remote and still 4 with two: legacy-b's range accepts legacy-a's 21.2.18
      // build, so a later round places them in its subpool. Under the gate pipeline this was 6, two islands.
      expect(downloads()).toBe(4);
    });
  });

  /**
   * Formerly a CHARACTERISATION of an open defect: each member elected its own winner, so a pool whose
   * members had their majorities on different lines split, and pooling amplified it (6 downloads, mfe-a
   * islanded on router). Electing the pool as one family fixes it.
   */
  describe('a pool elects as one family, whatever each member’s majority is', () => {
    it('keeps a family whole when each member has its majority on a different line', async () => {
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

      // mfe-a's build serves three remotes against legacy-a's two, so the whole family is 22; the legacy
      // pair runs legacy-a's 21 build together.
      expect(winner('@angular/core')).toBe('22.0.8');
      expect(winner('@angular/router')).toBe('22.0.8');
      expect(islandedRemotes()).toEqual([
        'team/legacy-a on @angular/core@22.0.8',
        'team/legacy-b on @angular/router@22.0.8',
      ]);
      expect(downloads()).toBe(4);
    });
  });
});
