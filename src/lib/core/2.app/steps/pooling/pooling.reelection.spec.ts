import type {
  DenseSharedInfo,
  ImportMap,
  RemoteEntry,
  SharedVersion,
  SharedVersionMeta,
} from 'lib/core/1.domain';
import { type CopySpec, portfolio } from 'lib/testing/pooling/portfolio';
import { outcome } from 'lib/testing/pooling/property-harness';

/**
 * When the init flow re-elects a pool, and what it does to stored pool state it does not re-elect. A share
 * scope is one unit of state: whenever any external in it changed, every pool of it is elected again, each
 * as one family, and a scope nobody changed keeps what storage holds. Pool state on an external that left
 * every pool is stale by definition and is cleared. See docs/version-resolver.md §"How the verdicts land in
 * the record and the map".
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

  // An unscoped external, so no npm-scope label pools it, carrying what an earlier pool stored on it: an
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

  it('leaves a pool alone when no member changed: a plain reload re-elects nothing', async () => {
    seedStaleIsland('framework', { core: false, common: false });

    await p.runInit();

    expect(causes()).toEqual([]);
  });

  // Also pins the whole pool: one/common was not dirty, and is elected with one/core all the same.
  it('re-elects every pool of the scope when one pool changed', async () => {
    seedStaleIsland('one', { core: true, common: false });
    seedStaleIsland('two', { core: false, common: false });

    await p.runInit();

    expect(causes()).toEqual([
      'mfe3@@one/common: incompatible',
      'mfe3@@one/core: incompatible',
      'mfe3@@two/common: incompatible',
      'mfe3@@two/core: incompatible',
    ]);
  });

  // Stored under an old name, so this also pins that a re-election renames the pool: the members are
  // written under the computed name and the island gains its cause. mfe1 also wins cold, so the winner
  // check alone does not prove a re-election ran.
  it('re-elects every pool of the scope when an external in no pool changed', async () => {
    seedStaleIsland('framework', { core: false, common: false }, 'old-name');
    p.seed('rxjs', [p.version('7.0.0', 'rxjs', [copy('mfe1', '^7.0.0')])]);

    await p.runInit();

    expect(p.record('@framework/core').poolName).toBe('framework');
    expect(p.record('@framework/common').poolName).toBe('framework');
    expect(p.record('@framework/core').poolWinner).toBe('mfe1');
    expect(causes()).toEqual([
      'mfe3@@framework/common: incompatible',
      'mfe3@@framework/core: incompatible',
    ]);
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
      // a and b ship the same family, so record order makes a the winner.
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

    /**
     * Redeploys that change a pool without dirtying the part that must be re-elected, which a warm page used
     * to keep as a stale election a full re-election of the same state would not make. The oracle is that
     * equivalence: warm after the redeploy ≡ every pool re-elected on the next page (`settled`). They pass
     * because any dirty external re-elects every pool of its scope and `removeFromAllScopes` marks the
     * same-`poolName` survivors of an external it deletes dirty.
     *
     * The equivalence alone holds vacuously when nothing stores a `poolName` (`reelect()` then re-elects
     * nothing), so each case also asserts the warm page directly.
     */
    describe('the part of a pool a redeploy changes is re-elected', () => {
      const sharedIn = (
        pool: string | null,
        packageName: string,
        version: string,
        requiredVersion: string,
        o: { strict?: boolean; entrypoints?: string[] } = {}
      ) =>
        ({
          packageName,
          version,
          requiredVersion,
          singleton: true,
          strictVersion: o.strict ?? true,
          ...(pool === null ? {} : { pool }),
          entries: Object.fromEntries(
            [packageName, ...(o.entrypoints ?? [])].map(s => [s, `${s.replace(/\//g, '_')}.js`])
          ),
        }) as DenseSharedInfo;

      const remote = (name: string, ...sharedInfo: DenseSharedInfo[]) =>
        entry(name, `http://${name}/remoteEntry.json`, ...sharedInfo);

      // The same remote redeployed: a new URL, so the warm page fetches it again and evicts its old copies.
      const redeployed = (name: string, ...sharedInfo: DenseSharedInfo[]) =>
        entry(name, `http://${name}/v2/remoteEntry.json`, ...sharedInfo);

      // What a page runs and how pooling placed it: per remote and specifier the tag it runs (`outcome`),
      // per remote its island, per pooled external its pool and winner.
      const settled = (q: ReturnType<typeof portfolio>, importMap: ImportMap) => {
        const record = q.stored();
        const pools: Record<string, string> = {};
        for (const [name, external] of Object.entries(record))
          if (external.poolName !== undefined)
            pools[name] = `${external.poolName} won by ${external.poolWinner}`;
        return {
          runs: outcome(importMap, record, q.scopeUrls()).runs,
          islands: q.islands(),
          pools,
        };
      };

      // Cold page of `before` (plus any `loaded` at runtime), warm page of `after` over it, then a warm page that re-elects every pool of
      // that same state. Not a cold page of `after`: a cold page breaks ties by record order where a warm one
      // keeps the stored winner, a difference that fix does not touch.
      const warmAndReelected = async (
        before: RemoteEntry[],
        after: RemoteEntry[],
        loaded: RemoteEntry[] = []
      ) => {
        const q = portfolio({}, { storage: 'nf-pooling-known-miss', realRepositories: true });
        await q.runInit(before);
        for (const entry of loaded) await q.runDynamic(entry);
        q.reload();
        const warm = settled(q, await q.runInit(after));
        q.reload();
        return { warm, reelected: settled(q, await q.reelect()) };
      };

      // N3. W, W2 and W3 ship `@x/core/testing` 2.0.0; R ships `@x/core` 1.0.0 with that entrypoint, which
      // makes them one pool `x`; S ships `@x/core/testing` 1.0.0 under a strict `~1.0.0`. R's build serves S
      // as a subpool. R redeploys shipping nothing: eviction deletes `@x/core`, the last external of the pool
      // R shipped. Unless eviction marks `@x/core/testing` dirty, nothing dirty is left, pooling skips
      // the scope, and S keeps `servedBy: R` from a remote that serves nothing, resolving the
      // global 2.0.0 its strict range rejects; a re-election scopes S on its own 1.0.0.
      it('re-elects the rest of a pool when eviction empties the scope of its last shipper', async () => {
        const W = (name: string) =>
          remote(name, sharedIn('x', '@x/core/testing', '2.0.0', '^2.0.0'));
        const R = remote(
          'R',
          sharedIn('x', '@x/core', '1.0.0', '~1.0.0', { entrypoints: ['@x/core/testing'] })
        );
        const S = remote('S', sharedIn('x', '@x/core/testing', '1.0.0', '~1.0.0'));
        const pages = await warmAndReelected(
          [W('W'), W('W2'), W('W3'), R, S],
          [W('W'), W('W2'), W('W3'), redeployed('R'), S]
        );

        expect(pages.reelected.runs['S|@x/core/testing']).toBe('1.0.0');
        expect(pages.warm.runs['S|@x/core/testing']).toBe('1.0.0');
        expect(pages.warm).toEqual(pages.reelected);
      });

      // F3. a and b are labelled `x` by everyone; c is labelled `y` by W and Q, but R labels it `x`, which
      // joins all three into one pool, where Q's c 1.0.0 islands Q's whole family `incompatible`. R redeploys
      // labelling c `y`: the pool splits into {a, b} and a lone c, but only c (whose copies changed) is
      // dirty. Unless every pool of the scope is re-elected, the untouched half keeps the merged election: Q's
      // a and b stay in `scope` rows (a second download of the global 2.0.0, `incompatible`) where a
      // re-election shares them.
      it('re-elects both halves when a label change splits a pool', async () => {
        const W = remote(
          'W',
          sharedIn('x', 'a', '2.0.0', '^2.0.0'),
          sharedIn('x', 'b', '2.0.0', '^2.0.0'),
          sharedIn('y', 'c', '2.0.0', '^2.0.0')
        );
        const Q = remote(
          'Q',
          sharedIn('x', 'a', '2.0.0', '^2.0.0'),
          sharedIn('x', 'b', '2.0.0', '^2.0.0'),
          sharedIn('y', 'c', '1.0.0', '~1.0.0')
        );
        const pages = await warmAndReelected(
          [W, Q, remote('R', sharedIn('x', 'c', '2.0.0', '^2.0.0'))],
          [W, Q, redeployed('R', sharedIn('y', 'c', '2.0.0', '^2.0.0'))]
        );

        expect(pages.reelected.islands).not.toHaveProperty('Q');
        expect(pages.warm.islands).not.toHaveProperty('Q');
        expect(pages.warm.pools).toEqual({ a: 'x won by W', b: 'x won by W' });
        expect(pages.warm).toEqual(pages.reelected);
      });

      // P1. Per-remote labels: Y labels a and b `p`, X labels a `q`, and W, V, U label c1 and c2 `q`; X's
      // label joins everything into one pool `q`, won by Y. X redeploys without `a`: the pool splits into
      // {a, b} (now `p`) and {c1, c2}, which keeps the name `q` and has no dirty member. Unless every pool of
      // the scope is re-elected, warm keeps `q`'s stale election: `poolWinner` Y, which ships no member of `q`, U's
      // 18 as a subpool for V, and W `uncovered`. A re-election elects V's 18 for `q` (global) and islands W
      // as `incompatible`.
      it('re-elects the half of a split pool that keeps its name', async () => {
        const lenient = (pool: string | null, name: string, version: string) =>
          sharedIn(pool, name, version, `^${version}`, { strict: false });
        const Y = remote('Y', lenient('p', 'a', '17.0.0'), lenient('p', 'b', '17.0.0'));
        const W = remote('W', lenient('q', 'c1', '17.0.0'), lenient('q', 'c2', '17.0.0'));
        const V = remote('V', lenient('q', 'c1', '18.0.0'), lenient('q', 'c2', '18.0.0'));
        const U = remote('U', lenient('q', 'c1', '18.0.0'), lenient('q', 'c2', '18.0.0'));
        const pages = await warmAndReelected(
          [Y, remote('X', lenient('q', 'a', '17.0.0')), W, V, U],
          [Y, redeployed('X', lenient(null, 'zzz', '1.0.0')), W, V, U]
        );

        expect(pages.reelected.pools['c1']).toBe('q won by V');
        expect(pages.warm.pools['c1']).toBe('q won by V');
        expect(pages.warm).toEqual(pages.reelected);
      });

      // A dynamic load merges a new pool into a committed one, and a later redeploy splits them again. R
      // labels p and q `x`; W and W2 label q `x`. D loads at runtime shipping `p/sub` and `r`, both labelled
      // `y`: `p/sub` joins p through the entrypoint edge, so `x` and `y` merge (`x` is the most declared),
      // and no committed build ships `p/sub`, so D serves its own family `uncovered`. R redeploys without
      // p: eviction deletes p, which cuts {p/sub, r} loose as `y` with no dirty member. Warm keeps D's
      // `uncovered` and elects no winner for `y`; a re-election elects `y` won by D, no island.
      it('re-elects a pool a dynamic load merged in once the redeploy splits it off', async () => {
        const R = remote(
          'R',
          sharedIn('x', 'p', '2.0.0', '^2.0.0'),
          sharedIn('x', 'q', '2.0.0', '^2.0.0')
        );
        const W = (name: string) => remote(name, sharedIn('x', 'q', '2.0.0', '^2.0.0'));
        const D = remote(
          'D',
          sharedIn('y', 'p/sub', '1.0.0', '~1.0.0'),
          sharedIn('y', 'r', '1.0.0', '~1.0.0')
        );
        const R2 = redeployed('R', sharedIn('x', 'q', '2.0.0', '^2.0.0'));

        const pages = await warmAndReelected([R, W('W'), W('W2')], [R2, W('W'), W('W2'), D], [D]);

        expect(pages.reelected.pools['r']).toBe('y won by D');
        expect(pages.warm.pools['r']).toBe('y won by D');
        expect(pages.warm.islands).toEqual({});
        expect(pages.warm).toEqual(pages.reelected);
      });

      // An `'always'` override of a cached remote dissolves a pool at runtime. R alone labels a `x`, every
      // other remote labels only b `x`, so R's label joins a and b into pool `x`; S and S2 run both at 1.0.0
      // under a strict ~1.0.0, served by S's build as a subpool. R's new build ships only an unrelated c, so a loses R's
      // copy (dirty) and no pool is left. If the dynamic step strips the stored pool state off a and b, b
      // (not dirty) is left as a plain `skip` with no stored name for the next init to re-elect it by, and
      // only a is re-elected: S and S2 then resolve b's global 2.0.0, which their range rejects. No generated
      // property reaches this (loads there add remotes, never override one), so this test and the dynamic
      // step's unit test for an external in no pool are the only guards.
      it('re-elects both members of a pool a dynamic override dissolves', async () => {
        const fam = (name: string, tag: string, range: string) =>
          remote(name, sharedIn(null, 'a', tag, range), sharedIn('x', 'b', tag, range));
        const others = [
          fam('W', '2.0.0', '^2.0.0'),
          fam('W2', '2.0.0', '^2.0.0'),
          fam('S', '1.0.0', '~1.0.0'),
          fam('S2', '1.0.0', '~1.0.0'),
        ];
        const R2 = redeployed('R', sharedIn(null, 'c', '1.0.0', '^1.0.0'));
        const q = portfolio({}, { storage: 'nf-pooling-dynamic-dissolve', realRepositories: true });
        await q.runInit([remote('R', sharedIn('x', 'a', '2.0.0', '^2.0.0')), ...others]);
        expect(q.record('b').poolName).toBe('x');

        await q.runDynamic(R2);
        expect(q.record('a').dirty).toBe(true);

        q.reload();
        const warm = await q.runInit([R2, ...others]);
        const { runs } = outcome(warm, q.stored(), q.scopeUrls());
        expect({ S: [runs['S|a'], runs['S|b']], S2: [runs['S2|a'], runs['S2|b']] }).toEqual({
          S: ['1.0.0', '1.0.0'],
          S2: ['1.0.0', '1.0.0'],
        });
      });
    });
  });
});
