import type {
  DenseSharedInfo,
  RemoteEntry,
  SharedVersion,
  SharedVersionMeta,
} from 'lib/core/1.domain';
import { type CopySpec, portfolio } from 'lib/testing/pooling/portfolio';

/**
 * When the init flow re-elects a pool, and what it does to stored pool state it does not re-elect. A pool
 * is one unit of state: whenever any member changed, every member is elected again as one family, and a
 * pool nobody changed keeps what storage holds. Pool state on an external that left every pool is stale by
 * definition and is cleared. See docs/version-resolver.md §"How the verdicts land in the record and the
 * map".
 *
 * Every init runs the real flow on the portfolio harness. The "stale" records below are ones a re-election
 * would change (an island stored without its `poolCause`), so whether a pool was re-elected can be read
 * off the record.
 */
describe('pooling re-election', () => {
  const SCOPE = Object.fromEntries(['mfe1', 'mfe2', 'mfe3'].map(name => [name, `http://${name}/`]));

  let p: ReturnType<typeof portfolio>;
  beforeEach(() => {
    p = portfolio(SCOPE, { storage: 'nf-pooling-reelection' });
  });

  const copy = (remote: string, req: string): CopySpec => ({ remote, req });

  const causes = (): string[] =>
    Object.entries(p.stored())
      .flatMap(([name, external]) =>
        external.versions.flatMap(v =>
          v.remotes.flatMap(r => (r.poolCause ? [`${r.name}@${name}: ${r.poolCause}`] : []))
        )
      )
      .sort();

  // mfe3 runs `pkg`'s family at 18 against the 17 majority, and the record serves it its own build, but
  // stores no `poolCause`: an election would add `incompatible` to both of its copies.
  const seedStaleIsland = (
    pkg: string,
    dirty: { core: boolean; common: boolean },
    poolName = pkg
  ) => {
    const stored = { poolName, poolWinner: 'mfe1' };
    const core = `@${pkg}/core`;
    const common = `@${pkg}/common`;
    p.seed(
      core,
      [
        p.version('17.0.0', core, [copy('mfe1', '^17.0.0'), copy('mfe2', '^17.0.0')], 'share'),
        p.version('18.0.0', core, [copy('mfe3', '^18.0.0')], 'scope'),
      ],
      dirty.core,
      stored
    );
    p.seed(
      common,
      [
        p.version('17.0.0', common, [copy('mfe1', '^17.0.0')], 'share'),
        p.version('17.0.0', common, [copy('mfe3', '^17.0.0')], 'scope'),
      ],
      dirty.common,
      stored
    );
  };

  // An unscoped external, so no npm-scope tag pools it, carrying what an earlier pool stored on it: an
  // island cause on mfe1's copy and a subpool on mfe2's.
  const seedLeftEveryPool = (dirty: boolean) => {
    const version = (
      tag: string,
      remote: string,
      action: SharedVersion['action'],
      state: Pick<SharedVersionMeta, 'servedBy' | 'poolCause'>
    ): SharedVersion => {
      const stored = p.version(tag, 'lonely', [copy(remote, '^1.0.0')], action);
      return { ...stored, remotes: stored.remotes.map(r => ({ ...r, ...state })) };
    };
    p.seed(
      'lonely',
      [
        version('1.0.0', 'mfe1', 'scope', { poolCause: 'incompatible' }),
        version('1.1.0', 'mfe2', 'skip', { servedBy: 'mfe1' }),
      ],
      dirty,
      { poolName: 'framework', poolWinner: 'mfe1' }
    );
  };

  it('re-elects the whole pool when one member changed', async () => {
    seedStaleIsland('framework', { core: true, common: false });

    await p.runInit();

    // common was not dirty, and is elected with core all the same.
    expect(causes()).toEqual([
      'mfe3@@framework/common: incompatible',
      'mfe3@@framework/core: incompatible',
    ]);
  });

  it('leaves a pool alone when no member changed: a plain reload re-elects nothing', async () => {
    seedStaleIsland('framework', { core: false, common: false });

    await p.runInit();

    expect(causes()).toEqual([]);
  });

  it('does not cross pool boundaries', async () => {
    // Two npm scopes are two pools, so the changed one must not drag the other in.
    seedStaleIsland('one', { core: true, common: false });
    seedStaleIsland('two', { core: false, common: false });

    await p.runInit();

    expect(causes()).toEqual(['mfe3@@one/common: incompatible', 'mfe3@@one/core: incompatible']);
  });

  it('renames a pool nobody changed, without re-electing it', async () => {
    seedStaleIsland('framework', { core: false, common: false }, 'old-name');
    // Something else in the scope changed, so this init does run pooling over the scope.
    p.seed('rxjs', [p.version('7.0.0', 'rxjs', [copy('mfe1', '^7.0.0')])]);

    await p.runInit();

    expect(p.record('@framework/core').poolName).toBe('framework');
    expect(p.record('@framework/common').poolName).toBe('framework');
    // A rename is no election: the stored winner rides along, and no island gains its cause.
    expect(p.record('@framework/core').poolWinner).toBe('mfe1');
    expect(causes()).toEqual([]);
  });

  // Regression for a leftover `servedBy` pointing a copy at a build after its pool had dissolved
  // (e2e/pooling/lifecycle.e2e.spec.ts, "drops a stale subpool").
  it('strips every pool result off an external that left every pool, and re-elects it', async () => {
    seedLeftEveryPool(true);

    const importMap = await p.runInit();

    const lonely = p.record('lonely');
    expect(lonely.poolName).toBeUndefined();
    expect(lonely.poolWinner).toBeUndefined();
    expect(lonely.versions.flatMap(v => v.remotes).filter(r => r.servedBy || r.poolCause)).toEqual(
      []
    );
    // Re-elected as a plain external: the newest tag both ranges take is shared.
    expect(lonely.versions.map(v => `${v.tag}:${v.action}`)).toEqual(['1.1.0:share', '1.0.0:skip']);
    expect(importMap.imports['lonely']).toBe('http://mfe2/lonely.js');
  });

  it('strips nothing on a warm init, however stale the record', async () => {
    seedLeftEveryPool(false);

    await p.runInit();

    const lonely = p.record('lonely');
    expect(lonely.poolName).toBe('framework');
    expect(lonely.versions[0]!.remotes[0]!.servedBy).toBe('mfe1');
  });

  /**
   * A warm page where one cached remote was redeployed: only that remote is fetched again (its URL changed),
   * its old copies are evicted, and the pool is re-elected around the cached builds that did not change.
   */
  describe('partial warm re-election', () => {
    const shared = (packageName: string, version: string, requiredVersion: string) =>
      ({
        packageName,
        version,
        requiredVersion,
        singleton: true,
        strictVersion: true,
        pool: 'fw',
        entries: { [packageName]: `${packageName.slice(1).replace('/', '_')}.js` },
      }) as DenseSharedInfo;

    const entry = (name: string, url: string, ...sharedInfo: DenseSharedInfo[]): RemoteEntry =>
      ({ name, url, exposes: [], shared: sharedInfo }) as unknown as RemoteEntry;

    const family = (tag: string, range: string) => [
      shared('@fw/core', tag, range),
      shared('@fw/common', tag, range),
    ];

    it('moves the winner off a cached build that changed, leaving the rest as cached', async () => {
      p = portfolio({}, { storage: 'nf-pooling-partial-warm', realRepositories: true });
      const a = entry('team/a', 'http://a/remoteEntry.json', ...family('17.0.0', '^17.0.0'));
      const b = entry('team/b', 'http://b/remoteEntry.json', ...family('17.0.0', '^17.0.0'));
      const c = entry(
        'team/c',
        'http://c/remoteEntry.json',
        shared('@fw/core', '17.0.0', '^17.0.0')
      );

      const cold = await p.runInit([a, b, c]);
      // a and b ship the same family, so arrival order makes a the winner.
      expect(cold.imports['@fw/core']).toBe('http://a/fw_core.js');
      expect(p.record('@fw/core').poolWinner).toBe('team/a');

      // a redeploys at a new URL with the next major; b and c are cached and not fetched again.
      p.reload();
      const a2 = entry('team/a', 'http://a/v2/remoteEntry.json', ...family('18.0.0', '^18.0.0'));
      const warm = await p.runInit([a2, b, c]);

      // b's build now serves b and c, so it wins although a was the stored winner; a runs its own 18.
      expect(p.record('@fw/core').poolWinner).toBe('team/b');
      expect(p.islands()).toEqual({ 'team/a': 'incompatible' });
      expect(warm.imports).toEqual({
        '@fw/core': 'http://b/fw_core.js',
        '@fw/common': 'http://b/fw_common.js',
      });
      expect(warm.scopes?.['http://a/v2/']).toEqual({
        '@fw/core': 'http://a/v2/fw_core.js',
        '@fw/common': 'http://a/v2/fw_common.js',
      });
      // a's 17 copies are gone with its old build.
      expect(
        p
          .record('@fw/core')
          .versions.map(v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name)}]`)
      ).toEqual(['18.0.0:scope:[team/a]', '17.0.0:share:[team/b,team/c]']);
    });
  });
});
