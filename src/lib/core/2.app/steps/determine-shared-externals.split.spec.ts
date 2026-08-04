import type { DrivingContract } from '../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockVersionRemote, newestFirst } from 'lib/testing/domain/externals/version.mock';
import type { SharedVersion } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createDetermineSharedExternals } from './determine-shared-externals';
import { createProcessRemoteEntries } from './process-remote-entries';
import { mockRemoteEntry_MFE2 } from 'lib/testing/domain/remote-entry/remote-entry.mock';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';

/**
 * Verdict granularity: `applyWinner` marks the copies that objected, not the rows they sit in. The whole
 * portfolio effect is in `pooling/per-copy-verdicts.regression.spec.ts`; this file is the mechanics —
 * what splits, what does not, and what the resulting record looks like.
 */
describe('determine: splitting a version on election', () => {
  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-split-on-election'),
      clearStorage: true,
    });
  });

  const version = (
    tag: string,
    remotes: {
      remote: string;
      req: string;
      strict?: boolean;
      cached?: boolean;
      entries?: Record<string, string>;
    }[],
    o: { host?: boolean } = {}
  ): SharedVersion => ({
    tag,
    host: o.host ?? false,
    action: 'skip',
    remotes: remotes.map(r =>
      mockVersionRemote(r.remote, 'dep-a', {
        requiredVersion: r.req,
        strictVersion: r.strict ?? true,
        cached: r.cached ?? false,
        ...(r.entries ? { entries: r.entries } : {}),
      })
    ),
  });

  const seed = (versions: SharedVersion[]) =>
    adapters.sharedExternalsRepo.addOrUpdate(
      'dep-a',
      { dirty: true, versions: newestFirst(versions, adapters.versionCheck.compare) },
      undefined
    );

  const rows = () =>
    adapters.sharedExternalsRepo
      .getFromScope(undefined)
      ['dep-a']!.versions.map(
        v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name).join(',')}]`
      );

  // The majority row is deliberately larger than the row that loses in every fixture below: the cost
  // model prices a scoped row at its uncached copies, so a mixed row only loses the election when the
  // winner's row has more copies than it does.
  const majority = (tag: string, count: number) =>
    version(
      tag,
      Array.from({ length: count }, (_, i) => ({ remote: `team/maj${i + 1}`, req: `^${tag}` }))
    );

  const majorityRow = (tag: string, count: number) =>
    `${tag}:share:[${Array.from({ length: count }, (_, i) => `team/maj${i + 1}`).join(',')}]`;

  it('leaves a row whole when every copy in it objects', async () => {
    seed([
      majority('2.2.0', 4),
      version('2.1.0', [
        { remote: 'team/mfe-c', req: '~2.1.0' },
        { remote: 'team/mfe-d', req: '~2.1.0' },
      ]),
    ]);

    await createDetermineSharedExternals(config, adapters)();

    // No empty `skip` row beside it.
    expect(rows()).toEqual([majorityRow('2.2.0', 4), '2.1.0:scope:[team/mfe-c,team/mfe-d]']);
  });

  it('splits three ways: acceptors and non-strict objectors dedup, strict objectors scope', async () => {
    seed([
      majority('2.2.0', 4),
      version('2.1.0', [
        { remote: 'team/mfe-a', req: '^2.1.0' }, // accepts 2.2.0
        { remote: 'team/mfe-c', req: '~2.1.0' }, // rejects, strict
        { remote: 'team/mfe-d', req: '~2.1.0', strict: false }, // rejects, but takes what is shared
      ]),
    ]);

    await createDetermineSharedExternals(config, adapters)();

    expect(rows()).toEqual([
      majorityRow('2.2.0', 4),
      '2.1.0:skip:[team/mfe-a,team/mfe-d]',
      '2.1.0:scope:[team/mfe-c]',
    ]);
  });

  it('never splits the winner, even where a copy of it rejects its own tag', async () => {
    // `latestSharedExternal` elects the newest row regardless of cost, so the winner is settled without
    // the fixture having to out-price anything.
    config.profile.latestSharedExternal = true;
    seed([
      version('22.1.0', [
        { remote: 'team/mfe1', req: '~22.0.0' }, // >=22.0.0 <22.1.0 — excludes the tag it ships
        { remote: 'team/mfe2', req: '^22.0.0' },
      ]),
      version('21.0.0', [{ remote: 'team/mfe3', req: '^21.0.0' }]),
    ]);

    await createDetermineSharedExternals(config, adapters)();

    // mfe1 stays in the shared row. A copy of the winner is never asked to accept the winner, so per-copy
    // verdicts must not start scoping copies that dedup today.
    expect(rows()).toEqual(['22.1.0:share:[team/mfe1,team/mfe2]', '21.0.0:scope:[team/mfe3]']);
  });

  it('never splits a host row', async () => {
    seed([
      version(
        '22.1.0',
        [
          { remote: 'team/host', req: '~22.0.0' },
          { remote: 'team/mfe2', req: '^22.0.0' },
        ],
        { host: true }
      ),
      version('21.0.0', [{ remote: 'team/mfe3', req: '^21.0.0' }]),
    ]);

    await createDetermineSharedExternals(config, adapters)();

    // Host precedence makes the host row the winner, so the winner exemption covers it — which is what
    // keeps a host copy out of a `scope` row, where `rebuildMember` would drop its `host` bit.
    expect(rows()).toEqual(['22.1.0:share:[team/host,team/mfe2]', '21.0.0:scope:[team/mfe3]']);
  });

  it('inserts the scope row beside its source, keeping the record newest-first', async () => {
    seed([
      majority('22.3.0', 3),
      version('22.2.0', [
        { remote: 'team/mfe-a', req: '^22.0.0' },
        { remote: 'team/mfe-c', req: '~22.2.0' },
      ]),
      version('22.1.0', [{ remote: 'team/mfe-x', req: '^22.0.0' }]),
    ]);

    await createDetermineSharedExternals(config, adapters)();

    // Appending the split row instead would put 22.2.0 after 22.1.0.
    expect(rows()).toEqual([
      majorityRow('22.3.0', 3),
      '22.2.0:skip:[team/mfe-a]',
      '22.2.0:scope:[team/mfe-c]',
      '22.1.0:skip:[team/mfe-x]',
    ]);

    const tags = adapters.sharedExternalsRepo
      .getFromScope(undefined)
      ['dep-a']!.versions.map(v => v.tag);
    tags.forEach((tag, i) => {
      if (i > 0) expect(adapters.versionCheck.compare(tags[i - 1]!, tag)).toBeGreaterThanOrEqual(0);
    });
  });

  it('subjects the newly deduping copy to the entrypoint coverage policy', async () => {
    // New interaction: while the copy sat in a `scope` row, `findTears` skipped it. Now that it dedups it
    // is checked like any other skip, and `scopeTornRemotes` merges it into the scope row already at its
    // tag — so a split can be undone by coverage, which is the right outcome and not a second row.
    config.profile.scopeUncoveredEntrypoints = true;
    seed([
      majority('2.2.0', 4),
      version('2.1.0', [
        {
          remote: 'team/mfe-a',
          req: '^2.1.0',
          entries: { 'dep-a': 'a.js', 'dep-a/extra': 'x.js' },
        },
        { remote: 'team/mfe-c', req: '~2.1.0' },
      ]),
    ]);

    await createDetermineSharedExternals(config, adapters)();

    expect(rows()).toEqual([majorityRow('2.2.0', 4), '2.1.0:scope:[team/mfe-c,team/mfe-a]']);
  });

  it('still refuses the portfolio under strictExternalCompatibility', async () => {
    config.strict.strictExternalCompatibility = true;
    seed([
      majority('2.2.0', 4),
      version('2.1.0', [
        { remote: 'team/mfe-a', req: '^2.1.0' },
        { remote: 'team/mfe-c', req: '~2.1.0' },
      ]),
    ]);

    // The strict check is asked of the row, above the split: one objecting copy still fails the portfolio.
    await expect(createDetermineSharedExternals(config, adapters)()).rejects.toThrow();
  });

  // The objective has to price a rejected row at the copies that really self-serve. Charging it for every
  // copy — which is what a whole-row verdict cost — both overstates candidates and makes the price depend
  // on whether the record was already split, i.e. on assembly order.
  describe('pricing the election', () => {
    // 2.3.0 costs one download (b1 alone keeps its build), 2.1.0 costs two (a1 and a2 both do). Charging
    // 2.1.0's whole row instead made 2.3.0 look like four and elected 2.1.0 — three downloads for a
    // portfolio that resolves in two.
    const flipPortfolio = () => [
      version('2.3.0', [
        { remote: 'team/a1', req: '~2.3.0' },
        { remote: 'team/a2', req: '~2.3.0' },
      ]),
      version('2.1.0', [
        { remote: 'team/b1', req: '~2.1.0' },
        { remote: 'team/b2', req: '^2.1.0' },
        { remote: 'team/b3', req: '^2.1.0' },
        { remote: 'team/b4', req: '^2.1.0' },
      ]),
    ];

    it('elects the candidate whose objectors are fewest, not whose rows are smallest', async () => {
      seed(flipPortfolio());

      await createDetermineSharedExternals(config, adapters)();

      // One shared build plus b1's own: two downloads, where electing 2.1.0 needs three.
      expect(rows()).toEqual([
        '2.3.0:share:[team/a1,team/a2]',
        '2.1.0:skip:[team/b2,team/b3,team/b4]',
        '2.1.0:scope:[team/b1]',
      ]);
    });

    it('charges nothing for an objector that is already downloaded', async () => {
      seed([
        version('2.3.0', [{ remote: 'team/a1', req: '~2.3.0' }]),
        version('2.1.0', [
          { remote: 'team/b1', req: '~2.1.0', cached: true },
          { remote: 'team/b2', req: '^2.1.0' },
        ]),
      ]);

      await createDetermineSharedExternals(config, adapters)();

      // b1 still scopes — `cached` changes the price, never the verdict.
      expect(rows()).toEqual([
        '2.3.0:share:[team/a1]',
        '2.1.0:skip:[team/b2]',
        '2.1.0:scope:[team/b1]',
      ]);
    });

    it('charges nothing for a non-strict objector, which takes what is shared', async () => {
      seed([
        version('2.3.0', [{ remote: 'team/a1', req: '~2.3.0' }]),
        version('2.1.0', [
          { remote: 'team/b1', req: '~2.1.0', strict: false },
          { remote: 'team/b2', req: '~2.1.0', strict: false },
        ]),
      ]);

      await createDetermineSharedExternals(config, adapters)();

      expect(rows()).toEqual(['2.3.0:share:[team/a1]', '2.1.0:skip:[team/b1,team/b2]']);
    });
  });

  it('routes a joiner at a split tag into the deduping row, then re-splits it', async () => {
    // `findVersionForTag` prefers the non-`scope` row, so a joiner at a tag that now has two lands in the
    // one that dedups whatever its own range says. That is only correct because joining dirties the
    // external: the re-election that follows is what puts it where it belongs.
    seed([
      majority('2.2.0', 4),
      version('2.1.0', [
        { remote: 'team/mfe-a', req: '^2.1.0' },
        { remote: 'team/mfe-c', req: '~2.1.0' },
      ]),
    ]);
    await createDetermineSharedExternals(config, adapters)();

    await createProcessRemoteEntries(
      config,
      adapters
    )([
      mockRemoteEntry_MFE2({
        shared: [
          mockSharedInfo('dep-a', {
            singleton: true,
            version: '2.1.0',
            requiredVersion: '~2.1.0', // rejects the 2.2.0 winner, like mfe-c
            strictVersion: true,
          }),
        ],
      }),
    ]);

    // Landed in the `skip` row beside a copy whose range accepts the winner, which on its own would have
    // it dedup onto a tag it rejects.
    expect(rows()).toEqual([
      majorityRow('2.2.0', 4),
      '2.1.0:skip:[team/mfe-a,team/mfe2]',
      '2.1.0:scope:[team/mfe-c]',
    ]);

    await createDetermineSharedExternals(config, adapters)();

    // Re-split, and merged with the scope row that was already there rather than left as a second one at
    // the same tag: `findVersionForTag` and `rebuildMember` both read a tag as at most one row per action.
    // Within a scope row the order is immaterial — every copy self-serves, so `remotes[0]` is not a basis.
    expect(rows()).toEqual([
      majorityRow('2.2.0', 4),
      '2.1.0:skip:[team/mfe-a]',
      '2.1.0:scope:[team/mfe2,team/mfe-c]',
    ]);
  });

  it('re-elects a record it has already split to the same thing', async () => {
    // Nothing merges the halves back, so a later init elects from a record holding two rows at one tag
    // where the first init saw one. Cold and warm therefore have to agree — both on the winner and on the
    // price behind it, which is why the objective counts copies rather than rows.
    seed([
      majority('22.3.0', 3),
      version('22.2.0', [
        { remote: 'team/mfe-a', req: '^22.0.0' },
        { remote: 'team/mfe-c', req: '~22.2.0' },
      ]),
    ]);

    await createDetermineSharedExternals(config, adapters)();
    const cold = rows();
    expect(cold).toEqual([
      majorityRow('22.3.0', 3),
      '22.2.0:skip:[team/mfe-a]',
      '22.2.0:scope:[team/mfe-c]',
    ]);

    // Exactly what the cold run persisted, handed back as a warm init reads it.
    const warm = structuredClone(adapters.sharedExternalsRepo.getFromScope(undefined)['dep-a']!);
    warm.dirty = true;
    adapters.sharedExternalsRepo.addOrUpdate('dep-a', warm, undefined);

    await createDetermineSharedExternals(config, adapters)();

    expect(rows()).toEqual(cold);
  });
});
