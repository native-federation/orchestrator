import type { RemoteEntry } from 'lib/core/1.domain';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { portfolio } from 'lib/testing/pooling/portfolio';
import { labelSharedInfoByNpmScope } from 'lib/testing/pooling/label-by-npm-scope';

/**
 * A bug inside one pool's election must not fail the whole init, nor leave that pool half-placed. The init
 * pooling step falls back to the placement that cannot tear. The failure is injected through the version
 * check port: asking it about the `@broken/*` copies' range throws, so judging that pool fails while the
 * `@ok/*` pool runs for real.
 */
describe('pooling contains a failure to the pool it happened in', () => {
  // Only the `@broken/*` copies carry this range.
  const BROKEN = '17.x';

  const rows = (p: ReturnType<typeof portfolio>, name: string) =>
    p
      .record(name)
      .versions.map(v => [
        `${v.tag}:${v.action}`,
        v.remotes.map(r => (r.poolCause ? `${r.name}(${r.poolCause})` : r.name)),
      ]);

  // Throws for the sentinel range whenever `armed()` says so; every other question is real semver.
  const breakRange = (p: ReturnType<typeof portfolio>, armed: () => boolean = () => true) => {
    const isCompatible = p.adapters.versionCheck.isCompatible;
    p.adapters.versionCheck.isCompatible = (version, range) => {
      if (range === BROKEN && armed()) throw new Error('range bug');
      return isCompatible(version, range);
    };
  };

  it('elects the healthy pool and gives the failed one the placement that cannot tear (init)', async () => {
    const p = portfolio(
      { 'team/a': 'http://a/', 'team/b': 'http://b/', 'team/c': 'http://c/' },
      { storage: 'nf-pool-containment' }
    );
    // Armed for the whole init: determine leaves a pool's members to pooling, so only the election, inside
    // the containment, ever asks about the broken range.
    breakRange(p);
    for (const family of ['@ok', '@broken'])
      for (const name of [`${family}/core`, `${family}/common`]) {
        const req = (major: string) => (family === '@broken' ? BROKEN : `^${major}.0.0`);
        p.seed(name, [
          p.version('17.0.0', name, [
            { remote: 'team/a', req: req('17') },
            { remote: 'team/b', req: req('17') },
          ]),
          p.version('16.0.0', name, [{ remote: 'team/c', req: req('16') }]),
        ]);
      }

    // The harness asserts no-tear on the map, so the fallback placement is checked to be tear-free too.
    await p.runInit();

    expect(rows(p, '@ok/core')).toEqual([
      ['17.0.0:share', ['team/a', 'team/b']],
      ['16.0.0:scope', ['team/c(incompatible)']],
    ]);
    // The first arrival keeps the global map; even team/b, which would have shared it, serves itself.
    expect(rows(p, '@broken/core')).toEqual([
      ['17.0.0:share', ['team/a']],
      ['17.0.0:scope', ['team/b(uncovered)']],
      ['16.0.0:scope', ['team/c(uncovered)']],
    ]);
    // Every member of the failed pool is placed, not only the one read first.
    expect(rows(p, '@broken/common')).toEqual([
      ['17.0.0:share', ['team/a']],
      ['17.0.0:scope', ['team/b(uncovered)']],
      ['16.0.0:scope', ['team/c(uncovered)']],
    ]);
    for (const name of ['@broken/core', '@broken/common']) {
      expect(p.record(name).poolName).toBe('broken');
      // An emergency placement is no election: it must not break the next healthy election's tie.
      expect(p.record(name).poolWinner).toBeUndefined();
    }
    expect(p.config.log.error).toHaveBeenCalledWith(
      3,
      expect.any(String),
      expect.objectContaining({ message: 'range bug' })
    );
  });

  it("keeps the host's build global when its pool cannot be judged (init)", async () => {
    const p = portfolio(
      { 'team/a': 'http://a/', 'team/b': 'http://b/', 'team/h': 'http://h/' },
      { hosts: ['team/h'], storage: 'nf-pool-containment-host' }
    );
    breakRange(p);
    for (const name of ['@broken/core', '@broken/common'])
      p.seed(name, [
        // team/a arrives first (the record lists the newest tag first): only the host rule keeps team/h.
        p.version('17.0.0', name, [
          { remote: 'team/a', req: BROKEN },
          { remote: 'team/b', req: BROKEN },
        ]),
        p.version('16.0.0', name, [{ remote: 'team/h', req: BROKEN, host: true }]),
      ]);

    await p.runInit();

    // The host cannot be repointed, so its build is the one placement that stays global.
    expect(rows(p, '@broken/core')).toEqual([
      ['17.0.0:scope', ['team/a(uncovered)', 'team/b(uncovered)']],
      ['16.0.0:share', ['team/h']],
    ]);
    expect(p.record('@broken/core').versions.find(v => v.action === 'share')!.host).toBe(true);
    expect(p.record('@broken/core').poolWinner).toBeUndefined();
  });

  // D14: the fallback writes no winner of its own, and must not keep the one the last election stored either.
  it('clears the stored winner when a re-elected pool cannot be judged (init)', async () => {
    const p = portfolio(
      { 'team/a': 'http://a/', 'team/b': 'http://b/' },
      { storage: 'nf-pool-containment-stored-winner' }
    );
    breakRange(p);
    for (const name of ['@broken/core', '@broken/common'])
      p.seed(
        name,
        [
          p.version('17.0.0', name, [
            { remote: 'team/a', req: BROKEN },
            { remote: 'team/b', req: BROKEN },
          ]),
        ],
        true,
        { poolName: 'broken', poolWinner: 'team/b' }
      );

    await p.runInit();

    for (const name of ['@broken/core', '@broken/common']) {
      expect(p.record(name).poolWinner).toBeUndefined();
      expect(p.record(name).poolName).toBe('broken');
    }
    // The first arrival keeps the map, not the stored winner.
    expect(rows(p, '@broken/core')).toEqual([
      ['17.0.0:share', ['team/a']],
      ['17.0.0:scope', ['team/b(uncovered)']],
    ]);
  });

  // D28: a malformed record (one remote, two rows of one member) is read as the remote's first row, whole,
  // as the election reads it. Reading every row, the host's second row would lend `x/testing` at 16.0.0, and
  // b's `x/testing` would make 16.0.0 the shared tag of a build whose first `x` row is 17.0.0.
  it('reads a malformed winner as its first row per member when its pool cannot be judged (init)', async () => {
    const p = portfolio(
      { 'team/b': 'http://b/', 'team/h': 'http://h/' },
      { hosts: ['team/h'], storage: 'nf-pool-containment-malformed', assertNoTear: false }
    );
    breakRange(p);
    p.seed('@broken/x', [
      p.version('18.0.0', '@broken/x', [
        { remote: 'team/b', req: BROKEN, entries: { '@broken/x/testing': 'b-testing.js' } },
      ]),
      p.version('17.0.0', '@broken/x', [
        { remote: 'team/h', req: BROKEN, host: true, entries: { '@broken/x': 'h-x-17.js' } },
      ]),
      p.version('16.0.0', '@broken/x', [
        {
          remote: 'team/h',
          req: BROKEN,
          entries: { '@broken/x': 'h-x-16.js', '@broken/x/testing': 'h-testing-16.js' },
        },
      ]),
    ]);
    p.seed('@broken/y', [
      p.version('17.0.0', '@broken/y', [{ remote: 'team/h', req: BROKEN, host: true }]),
    ]);

    await p.runInit();

    expect(rows(p, '@broken/x')).toEqual([
      ['18.0.0:scope', ['team/b(uncovered)']],
      ['17.0.0:share', ['team/h']],
      ['16.0.0:skip', ['team/h']],
    ]);
  });
});
