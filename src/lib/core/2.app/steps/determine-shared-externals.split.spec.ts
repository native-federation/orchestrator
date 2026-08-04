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
    remotes: { remote: string; req: string; strict?: boolean; entries?: Record<string, string> }[],
    o: { host?: boolean } = {}
  ): SharedVersion => ({
    tag,
    host: o.host ?? false,
    action: 'skip',
    remotes: remotes.map(r =>
      mockVersionRemote(r.remote, 'dep-a', {
        requiredVersion: r.req,
        strictVersion: r.strict ?? true,
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
      .getFromScope(undefined)['dep-a']!.versions.map(
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
      .getFromScope(undefined)['dep-a']!.versions.map(v => v.tag);
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
        { remote: 'team/mfe-a', req: '^2.1.0', entries: { 'dep-a': 'a.js', 'dep-a/extra': 'x.js' } },
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

  it('re-elects an already-split record to itself', async () => {
    // The shape the fix persists, fed back in: two rows at one tag, one `skip`, one `scope`. A later init
    // re-elects from storage, and nothing merges the halves back, so this has to be a fixed point.
    seed([
      majority('22.3.0', 3),
      { ...version('22.2.0', [{ remote: 'team/mfe-a', req: '^22.0.0' }]), action: 'skip' },
      { ...version('22.2.0', [{ remote: 'team/mfe-c', req: '~22.2.0' }]), action: 'scope' },
    ]);

    await createDetermineSharedExternals(config, adapters)();

    expect(rows()).toEqual([
      majorityRow('22.3.0', 3),
      '22.2.0:skip:[team/mfe-a]',
      '22.2.0:scope:[team/mfe-c]',
    ]);
  });
});
