import {
  GLOBAL_SCOPE,
  STRICT_SCOPE,
  type SharedVersion,
  type SharedVersionMeta,
} from 'lib/core/1.domain';
import { NFError } from 'lib/core/native-federation.error';
import { type CopySpec, portfolio, type PortfolioOptions } from 'lib/testing/pooling/portfolio';
import { storedRecord } from 'lib/testing/pooling/portfolio-fixtures';

/**
 * The init election, through the real init flow on the portfolio harness: stored records in, the record
 * and the import map out. Every init also asserts the no-tear oracle and that every pooled specifier
 * resolves. Islands and subpools are read off the stored record, never off the warnings.
 *
 * Seeded records start dirty, as a fresh registration leaves them, unless a case says otherwise. Scoped
 * packages carry their npm-scope pool tag, as the build adds by default.
 */
describe('createPoolSharedExternals', () => {
  const SCOPE = Object.fromEntries(
    [
      'a',
      'b',
      'c',
      'd',
      'r',
      'w',
      'w2',
      'w3',
      'w4',
      'x',
      'y',
      'host',
      'legacy',
      'legacy-a',
      'legacy-b',
      'mfe1',
      'mfe2',
      'mfe3',
      'R',
    ].map(name => [name, `http://${name}/`])
  );

  let p: ReturnType<typeof portfolio>;
  const page = (options: PortfolioOptions = {}) =>
    (p = portfolio(SCOPE, { storage: 'nf-pool-shared-externals', ...options }));
  beforeEach(() => page());

  // One copy; `req` defaults to the `17` every untold fixture shares.
  const copy = (
    remote: string,
    req = '17',
    o: Omit<CopySpec, 'remote' | 'req'> = {}
  ): CopySpec => ({
    remote,
    req,
    ...o,
  });
  const at = (
    tag: string,
    external: string,
    copies: CopySpec[],
    action?: SharedVersion['action']
  ): SharedVersion => p.version(tag, external, copies, action);

  // A copy as an earlier election stored it.
  const withState = (
    version: SharedVersion,
    remote: string,
    state: Pick<SharedVersionMeta, 'servedBy' | 'poolCause'>
  ): SharedVersion => ({
    ...version,
    remotes: version.remotes.map(r => (r.name === remote ? { ...r, ...state } : r)),
  });

  const rowsOf = (name: string) =>
    p.record(name).versions.map(v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name)}]`);

  const shareOf = (name: string) => p.record(name).versions.find(v => v.action === 'share');

  const namesOf = (name: string, action: SharedVersion['action']): string[] =>
    p
      .record(name)
      .versions.filter(v => v.action === action)
      .flatMap(v => v.remotes.map(r => r.name))
      .sort();

  const causeOf = (name: string, remote: string) =>
    p
      .record(name)
      .versions.flatMap(v => v.remotes)
      .find(r => r.name === remote)?.poolCause;

  // Every verdict the record holds: a scoped copy's `poolCause` and a subpool copy's `servedBy`.
  const verdicts = (): string[] =>
    Object.entries(p.stored())
      .flatMap(([name, external]) =>
        external.versions
          .flatMap(v => v.remotes)
          .flatMap(r => [
            ...(r.poolCause ? [`${r.name}@${name}: ${r.poolCause}`] : []),
            ...(r.servedBy ? [`${r.name}@${name}: served by ${r.servedBy}`] : []),
          ])
      )
      .sort();

  // What an election decides, without what the import map marks on the way out (`cached`, `dirty`).
  const decided = (name: string) => {
    const { dirty: _dirty, versions, ...rest } = p.record(name);
    return {
      ...rest,
      versions: versions.map(v => ({
        ...v,
        remotes: v.remotes.map(({ cached: _cached, ...meta }) => meta),
      })),
    };
  };

  // a's build serves the majority (core + common). c and d agree on core but lack common, and ship cdk at
  // two tags their strict ranges keep apart.
  const seedCoverageMiss = () => {
    p.seed('@framework/core', [
      at('17.0.0', '@framework/core', [
        copy('a', '^17.0.0'),
        copy('b', '^17.0.0'),
        copy('c', '^17.0.0'),
        copy('d', '^17.0.0'),
      ]),
    ]);
    p.seed('@framework/common', [
      at('17.0.0', '@framework/common', [copy('a', '^17.0.0'), copy('b', '^17.0.0')]),
    ]);
    p.seed('@framework/cdk', [
      at('17.1.0', '@framework/cdk', [copy('d', '~17.1.0')]),
      at('17.0.0', '@framework/cdk', [copy('c', '~17.0.0')]),
    ]);
  };

  describe('when inert', () => {
    it('stores no pool state when no pool tag is present', async () => {
      // Unscoped packages carry no npm-scope tag, so nothing pools them.
      p.seed('foo', [at('17.0.0', 'foo', [copy('mfe1')], 'share')]);
      p.seed('bar', [at('17.0.0', 'bar', [copy('mfe1')], 'share')]);

      await p.runInit();

      expect(p.record('foo').poolName).toBeUndefined();
      expect(p.record('bar').poolName).toBeUndefined();
      expect(verdicts()).toEqual([]);
    });

    it('rebuilds a single-remote pool already stored as elected unchanged', async () => {
      const stored = { poolName: 'framework', poolWinner: 'mfe1' };
      p.seed(
        '@framework/core',
        [at('17.0.0', '@framework/core', [copy('mfe1')], 'share')],
        true,
        stored
      );
      p.seed(
        '@framework/common',
        [at('17.0.0', '@framework/common', [copy('mfe1')], 'share')],
        true,
        stored
      );
      const seeded = { core: decided('@framework/core'), common: decided('@framework/common') };

      await p.runInit();

      expect(decided('@framework/core')).toEqual(seeded.core);
      expect(decided('@framework/common')).toEqual(seeded.common);
    });

    it('leaves a single-member pool to determine', async () => {
      // One member is no pool: determine elects it like any external, and nothing pooled is stored.
      p.seed('@framework/core', [
        at('17.0.0', '@framework/core', [copy('mfe1')], 'share'),
        at('18.0.0', '@framework/core', [copy('mfe2', '18')]),
      ]);

      await p.runInit();

      expect(p.record('@framework/core').poolName).toBeUndefined();
      expect(verdicts()).toEqual([]);
    });

    it('never pools the strict scope', async () => {
      // Under per-member election mfe2's ^18 would island it across the family; the strict scope shares
      // every version instead.
      page({ scope: STRICT_SCOPE });
      p.seed('@framework/core', [
        at('17.0.0', '@framework/core', [copy('mfe1', '^17.0.0')]),
        at('18.0.0', '@framework/core', [copy('mfe2', '^18.0.0')]),
      ]);
      p.seed('@framework/common', [
        at('17.0.0', '@framework/common', [copy('mfe1', '^17.0.0'), copy('mfe2', '^17.0.0')]),
      ]);

      await p.runInit();

      expect(p.record('@framework/core').poolName).toBeUndefined();
      expect(verdicts()).toEqual([]);
    });
  });

  // W1: a scope carrying no pool state is not pooled. Pooling's work shows up as storage writes of the scope it
  // pools, so a scope without pool state must cost exactly what it costs on a page with no pool anywhere. Which
  // scopes are pooled at all is pinned by the `poolableScopes` spec in pool.util.spec.ts.
  describe('skips work', () => {
    // team-b holds foo and bar, tagged into one pool or not; `pooledElsewhere` adds a pool to the global
    // scope. Counts team-b's storage writes over one init, and those that carry a pool result.
    const trafficOf = async (o: { tagged: boolean; pooledElsewhere: boolean }) => {
      page({ scope: 'team-b' });
      const tag = o.tagged ? { pool: 'grp' } : {};
      p.seed('foo', [
        at('17.0.0', 'foo', [copy('mfe1', '17', tag)]),
        at('18.0.0', 'foo', [copy('mfe2', '18', tag)]),
      ]);
      p.seed('bar', [at('17.0.0', 'bar', [copy('mfe1', '17', tag)])]);
      if (o.pooledElsewhere)
        for (const name of ['@framework/core', '@framework/common'])
          p.adapters.sharedExternalsRepo.addOrUpdate(
            name,
            storedRecord(
              name,
              [at('17.0.0', name, [copy('mfe1'), copy('mfe2')])],
              p.adapters.versionCheck.compare
            ),
            GLOBAL_SCOPE
          );

      const writes = vi.spyOn(p.adapters.sharedExternalsRepo, 'addOrUpdate');
      await p.runInit();
      const inTeamB = writes.mock.calls.filter(([, , scope]) => scope === 'team-b');
      return {
        writes: inTeamB.length,
        poolNames: inTeamB.filter(([, external]) => external.poolName !== undefined).length,
        pooledElsewhere:
          p.adapters.sharedExternalsRepo.getFromScope(GLOBAL_SCOPE)['@framework/core']?.poolName,
      };
    };

    it('writes a scope without pool state as if no scope had any (W1)', async () => {
      const alone = await trafficOf({ tagged: false, pooledElsewhere: false });
      const besidePool = await trafficOf({ tagged: false, pooledElsewhere: true });
      const pooled = await trafficOf({ tagged: true, pooledElsewhere: false });

      expect(besidePool.pooledElsewhere).toBe('framework');
      expect(besidePool.writes).toBe(alone.writes);
      expect(besidePool.poolNames).toBe(0);
      // The control: pooling the scope itself does show up in its writes. Not in their number, since pooling
      // rewrites the members `determine` left to it, but in the `poolName` they carry.
      expect(pooled.poolNames).toBeGreaterThan(alone.poolNames);
    });
  });

  describe('membership', () => {
    it('pools via an explicit remote pool tag', async () => {
      for (const name of ['foo', 'bar'])
        p.seed(name, [
          at(
            '17.0.0',
            name,
            [copy('mfe1', '17', { pool: 'grp' }), copy('mfe2', '17', { pool: 'grp' })],
            'share'
          ),
        ]);

      await p.runInit();

      // Both builds serve both remotes; which one wins the tie does not matter here.
      for (const name of ['foo', 'bar']) {
        expect(p.record(name).poolName).toBe('grp');
        expect(namesOf(name, 'share')).toEqual(['mfe1', 'mfe2']);
      }
    });
  });

  /**
   * The election itself, on real semver: round 1 picks the build serving the most remotes as the global one,
   * later rounds place what is left in subpools, and everyone left serves themselves. The actions on the
   * seeded rows are ignored — pooling elects its members — except the stored winner, which breaks ties.
   */
  describe('variant election', () => {
    it('elects the build that serves the most remotes, even an older one', async () => {
      // a ships core + forms at 17.0.0, b only core at 17.1.0. Both ranges take either, but only a's
      // build serves both remotes, so the family runs 17.0.0 and b dedups onto it.
      p.seed('@framework/core', [
        at('17.1.0', '@framework/core', [copy('b', '^17.0.0')], 'share'),
        at('17.0.0', '@framework/core', [copy('a', '^17.0.0')]),
      ]);
      p.seed('@framework/forms', [at('17.0.0', '@framework/forms', [copy('a', '^17.0.0')])]);

      await p.runInit();

      expect(rowsOf('@framework/core')).toEqual(['17.1.0:skip:[b]', '17.0.0:share:[a]']);
      expect(rowsOf('@framework/forms')).toEqual(['17.0.0:share:[a]']);
      expect(verdicts()).toEqual([]);
    });

    it("forces the host's build as round 1 whatever it serves", async () => {
      // b's build would serve both remotes; the host's serves only itself, and still wins.
      page({ hosts: ['host'] });
      p.seed('@framework/core', [
        at('17.1.0', '@framework/core', [copy('b', '^17.0.0')]),
        at('17.0.0', '@framework/core', [copy('host', '~17.0.0', { host: true })]),
      ]);
      p.seed('@framework/forms', [at('17.1.0', '@framework/forms', [copy('b', '^17.0.0')])]);

      await p.runInit();

      expect(shareOf('@framework/core')).toMatchObject({ tag: '17.0.0', host: true });
      expect(shareOf('@framework/core')!.remotes[0]!.name).toBe('host');
    });

    it('keeps the host flag on a re-election whose host tag also holds another row', async () => {
      // The record a previous election stored: x shares host's core@17.0.0 but its common@18 rejects the
      // elected 17, so x's copies are islanded into a `scope` row at the host's own tag. The rows of one tag
      // must not decide the host flag between them — the last one read (`scope`) would drop it, and the next
      // re-election would no longer know which build cannot be repointed.
      page({ hosts: ['host'] });
      p.seed('@framework/core', [
        at('17.0.0', '@framework/core', [copy('host', '~17.0.0', { host: true })], 'share'),
        at('17.0.0', '@framework/core', [copy('x', '^17.0.0')], 'scope'),
      ]);
      p.seed('@framework/common', [
        at('18.0.0', '@framework/common', [copy('x', '^18.0.0')], 'scope'),
        at('17.0.0', '@framework/common', [copy('host', '~17.0.0', { host: true })], 'share'),
      ]);

      await p.runInit();

      expect(rowsOf('@framework/core')).toEqual(['17.0.0:share:[host]', '17.0.0:scope:[x]']);
      expect(p.record('@framework/core').versions.map(v => v.host)).toEqual([true, false]);
      expect(shareOf('@framework/common')).toMatchObject({ tag: '17.0.0', host: true });
    });

    // Two builds that each serve only themselves and agree with nobody; a arrives first and is newer.
    const seedTied = (winners: { core?: string; common?: string }) => {
      for (const [name, poolWinner] of [
        ['@framework/core', winners.core],
        ['@framework/common', winners.common],
      ] as const)
        p.seed(
          name,
          [
            at('18.0.0', name, [copy('a', '~18.0.0')]),
            at('17.0.0', name, [copy('b', '~17.0.0')], 'share'),
          ],
          true,
          { poolWinner }
        );
    };

    it('keeps the stored winner on a tie', async () => {
      // b won last time, so b keeps it, although a is the newer build.
      seedTied({ core: 'b', common: 'b' });

      await p.runInit();

      expect(shareOf('@framework/core')!.tag).toBe('17.0.0');
      expect(p.record('@framework/core').poolWinner).toBe('b');
    });

    it('ignores a stored winner the members disagree on', async () => {
      seedTied({ core: 'b', common: 'a' });

      await p.runInit();

      // No previous winner, so arrival order breaks the tie.
      expect(shareOf('@framework/core')!.tag).toBe('18.0.0');
      expect(p.record('@framework/common').poolWinner).toBe('a');
    });

    it('keeps the stored winner when a member that joined since carries none', async () => {
      seedTied({ core: 'b' });

      await p.runInit();

      expect(shareOf('@framework/core')!.tag).toBe('17.0.0');
      expect(p.record('@framework/common').poolWinner).toBe('b');
    });

    it('ignores a stored winner that ships no member any more', async () => {
      seedTied({ core: 'gone', common: 'gone' });

      await p.runInit();

      expect(shareOf('@framework/core')!.tag).toBe('18.0.0');
      expect(p.record('@framework/core').poolWinner).toBe('a');
    });

    it('takes the newest build first under latestSharedExternal', async () => {
      p.config.profile.latestSharedExternal = true;
      // a's 17.9.0 build serves both remotes, b's 17.10.0 only b; the flag puts the newest first anyway.
      // Newest by semver: compared as strings, 17.9.0 would sort above 17.10.0.
      p.seed('@framework/core', [
        at('17.10.0', '@framework/core', [copy('b', '^17.0.0')]),
        at('17.9.0', '@framework/core', [copy('a', '^17.0.0')]),
      ]);
      p.seed('@framework/forms', [at('17.9.0', '@framework/forms', [copy('a', '^17.0.0')])]);

      await p.runInit();

      expect(shareOf('@framework/core')!.tag).toBe('17.10.0');
      // a cannot take b's build (b ships no forms), so it serves its own family.
      expect(verdicts()).toEqual(['a@@framework/core: uncovered', 'a@@framework/forms: uncovered']);
    });

    describe('which build is newer', () => {
      // x runs core@17.10 with zz@9, y runs core@17.9 with zz@99. The highest tag either ships is y's zz@99,
      // but that line has nothing to do with core's: builds compare member by member, and core (first by
      // name) decides — x is newer by semver, though '17.9.0' sorts above '17.10.0' as a string. Tilde
      // ranges keep each build serving only itself.
      const seedPortfolio = (coreAt17_9: CopySpec[] = []) => {
        p.seed('@framework/core', [
          at('17.10.0', '@framework/core', [copy('x', '~17.10.0')]),
          at('17.9.0', '@framework/core', [copy('y', '~17.9.0'), ...coreAt17_9]),
        ]);
        p.seed('@framework/zz', [
          at('99.0.0', '@framework/zz', [copy('y', '~99.0.0')]),
          at('9.0.0', '@framework/zz', [copy('x', '~9.0.0')]),
        ]);
      };

      it('breaks the last tie by the first member whose tags differ, never across lines', async () => {
        seedPortfolio();

        await p.runInit();

        expect(shareOf('@framework/core')!.remotes[0]!.name).toBe('x');
      });

      it('puts the newer build first under latestSharedExternal, compared the same way', async () => {
        p.config.profile.latestSharedExternal = true;
        // y now serves a second remote, which would win it round 1 without the flag.
        seedPortfolio([copy('w', '~17.9.0')]);

        await p.runInit();

        expect(shareOf('@framework/core')!.remotes[0]!.name).toBe('x');
      });
    });

    it('breaks a tie on served remotes toward the build more remotes agree with', async () => {
      // Every build serves only itself. a and b agree on core@17; c runs 18. Newest-first would elect c
      // and island both 17 remotes; agreement elects a 17 build, which a and b then share.
      p.seed('@framework/core', [
        at('18.0.0', '@framework/core', [copy('c', '^18.0.0')]),
        at('17.0.0', '@framework/core', [copy('a', '^17.0.0'), copy('b', '^17.0.0')]),
      ]);
      p.seed('@framework/common', [
        at('17.0.0', '@framework/common', [copy('a', '^17.0.0'), copy('c', '^17.0.0')]),
      ]);
      p.seed('@framework/cdk', [at('17.0.0', '@framework/cdk', [copy('b', '^17.0.0')])]);

      await p.runInit();

      expect(shareOf('@framework/core')!.tag).toBe('17.0.0');
      expect(namesOf('@framework/core', 'scope')).toEqual(['c']);
    });

    it('places what round 1 left in a subpool running one build, through scopes', async () => {
      // Two 21 remotes beside a 22 majority: legacy-a's build serves legacy-b (~21.2.0 takes 21.2.18).
      p.seed('@framework/core', [
        at('22.0.8', '@framework/core', [copy('a', '^22.0.0'), copy('b', '^22.0.0')]),
        at('21.2.18', '@framework/core', [copy('legacy-a', '~21.2.0')]),
        at('21.2.15', '@framework/core', [copy('legacy-b', '~21.2.0')]),
      ]);
      p.seed('@framework/router', [
        at('22.0.8', '@framework/router', [copy('a', '^22.0.0')]),
        at('21.2.18', '@framework/router', [copy('legacy-a', '~21.2.0')]),
      ]);

      await p.runInit();

      // The subpool's build names itself so its own scope maps its family; its members name the build.
      // Neither is scoped: a subpool copy carries `servedBy`, never a `poolCause`.
      expect(namesOf('@framework/core', 'scope')).toEqual([]);
      expect(verdicts()).toEqual([
        'legacy-a@@framework/core: served by legacy-a',
        'legacy-a@@framework/router: served by legacy-a',
        'legacy-b@@framework/core: served by legacy-a',
      ]);
    });

    it('forms no subpool of one: a lone remote serves itself', async () => {
      p.seed('@framework/core', [
        at('22.0.8', '@framework/core', [copy('a', '^22.0.0'), copy('b', '^22.0.0')]),
        at('21.2.18', '@framework/core', [copy('legacy', '~21.2.0')]),
      ]);
      p.seed('@framework/router', [
        at('22.0.8', '@framework/router', [copy('a', '^22.0.0')]),
        at('21.2.18', '@framework/router', [copy('legacy', '~21.2.0')]),
      ]);

      await p.runInit();

      expect(namesOf('@framework/core', 'scope')).toEqual(['legacy']);
      expect(namesOf('@framework/router', 'scope')).toEqual(['legacy']);
      expect(verdicts()).toEqual([
        'legacy@@framework/core: incompatible',
        'legacy@@framework/router: incompatible',
      ]);
    });

    it('never lets a disagreeing remote take a same-version global file', async () => {
      // c runs core@18 and common@17 — the elected common's tag. Taking the global common file would bind
      // it to the global core@17 one import in, beside c's own core@18: two cores in c.
      p.seed('@framework/core', [
        at('18.0.0', '@framework/core', [copy('c', '^18.0.0')]),
        at('17.0.0', '@framework/core', [copy('a', '^17.0.0'), copy('b', '^17.0.0')]),
      ]);
      p.seed('@framework/common', [
        at('17.0.0', '@framework/common', [copy('a', '^17.0.0'), copy('c', '^17.0.0')]),
      ]);

      await p.runInit();

      expect(namesOf('@framework/common', 'scope')).toEqual(['c']);
      expect(namesOf('@framework/common', 'share')).toEqual(['a']);
    });

    it('lets an agreeing remote take the elected files and serve only the rest itself', async () => {
      // b and c agree with a on core@17 but ship cdk at two different tags, so cdk cannot be published for
      // both: each runs its own cdk and takes the global core.
      p.seed('@framework/core', [
        at('17.0.0', '@framework/core', [
          copy('a', '^17.0.0'),
          copy('b', '^17.0.0'),
          copy('c', '^17.0.0'),
        ]),
      ]);
      p.seed('@framework/common', [at('17.0.0', '@framework/common', [copy('a', '^17.0.0')])]);
      p.seed('@framework/cdk', [
        at('17.1.0', '@framework/cdk', [copy('b', '~17.1.0')]),
        at('17.0.0', '@framework/cdk', [copy('c', '~17.0.0')]),
      ]);

      await p.runInit();

      expect(namesOf('@framework/core', 'share')).toEqual(['a', 'b', 'c']);
      expect(namesOf('@framework/cdk', 'scope')).toEqual(['b', 'c']);
      expect(verdicts()).toEqual(['b@@framework/cdk: uncovered', 'c@@framework/cdk: uncovered']);
    });

    it('shares a package the winner ships only as secondary entrypoints', async () => {
      // `@framework/material` is declared with `/table` alone — no root entry — so round 1 serves the package
      // through its entrypoint, and the record still has to say which copy is shared.
      p.seed('@framework/core', [
        at('17.0.0', '@framework/core', [copy('a', '^17.0.0'), copy('b', '^17.0.0')]),
      ]);
      p.seed('@framework/material', [
        at('17.0.0', '@framework/material', [
          copy('a', '^17.0.0', { entries: { '@framework/material/table': 'table.js' } }),
        ]),
      ]);

      await p.runInit();

      expect(rowsOf('@framework/material')).toEqual(['17.0.0:share:[a]']);
    });

    describe('a package shipped only as secondary entrypoints', () => {
      const material = '@framework/material';
      const entrypoint = (remote: string, name: string) =>
        copy(remote, '^17.0.0', { entries: { [`${material}/${name}`]: `${name}.js` } });
      const seedCore = () =>
        p.seed('@framework/core', [
          at('17.0.0', '@framework/core', [
            copy('a', '^17.0.0'),
            copy('b', '^17.0.0'),
            copy('c', '^17.0.0'),
          ]),
        ]);

      it('pins an entrypoint nobody published by its siblings, so the package keeps one tag', async () => {
        // b and c ship `/sort` at 17.0.2 and win round 1. a ships only `/table`, at 17.0.0. Neither build
        // lists the package root, so `/table` is pinned by `/sort`'s tag: a disagrees, and its 17.0.0 table
        // must not be published beside the elected 17.0.2 sort — two Material builds in one map.
        seedCore();
        p.seed(material, [
          at('17.0.2', material, [entrypoint('b', 'sort'), entrypoint('c', 'sort')]),
          at('17.0.0', material, [entrypoint('a', 'table')]),
        ]);

        await p.runInit();

        expect(rowsOf(material)).toEqual(['17.0.2:share:[b,c]', '17.0.0:scope:[a]']);
        expect(verdicts()).toEqual([
          'a@@framework/core: uncovered',
          'a@@framework/material: uncovered',
        ]);
      });

      it('publishes a sibling entrypoint shipped at the elected tag', async () => {
        // Same shape, but a's `/table` is at the elected 17.0.2: one Material build, so it is served
        // globally.
        seedCore();
        p.seed(material, [
          at('17.0.2', material, [
            entrypoint('b', 'sort'),
            entrypoint('c', 'sort'),
            entrypoint('a', 'table'),
          ]),
        ]);

        await p.runInit();

        // Every build borrows the other entrypoint at the same tag in round 1, so all three serve everyone
        // and which copy leads the row is only the tiebreak; one row is the point.
        expect(p.record(material).versions).toHaveLength(1);
        expect(namesOf(material, 'share')).toEqual(['a', 'b', 'c']);
        expect(verdicts()).toEqual([]);
      });
    });

    it('keeps a build round 1 borrows an entrypoint from on a route that publishes it', async () => {
      // b agrees with w's core@1.1 and is the only build shipping core/testing@1.1, which round 1 borrows to
      // serve r (core@1.0 + testing, ^1). b misses round 1 (it needs p, which w lacks). In a's subpool
      // (core@1.2, disagreeing), b's copy would be servedBy a and nothing would publish core/testing@1.1: r
      // would self-fill a 1.0 testing next to the global 1.1 core. The subpool runs b's build instead (a and
      // b), agreeing, so the extension publishes p from it — and then serves both a and b, whose ^1 takes the
      // global 1.1: the subpool dissolves into round 1 and b's testing is shared.
      const core = '@framework/core';
      const testing = '@framework/core/testing';
      const files = (...specifiers: string[]) => ({
        entries: Object.fromEntries(specifiers.map(s => [s, `${s}.js`])),
      });
      const ships = (remote: string, ...specifiers: string[]) =>
        copy(remote, '^1.0.0', files(...specifiers));
      p.seed(core, [
        at('1.2.0', core, [ships('a', core, testing)]),
        at('1.1.0', core, [
          ships('w', core),
          ships('w2', core),
          ships('w3', core),
          ships('w4', core),
          ships('b', core, testing),
        ]),
        at('1.0.0', core, [ships('r', core, testing)]),
      ]);
      p.seed('@framework/q', [
        at(
          '1.0.0',
          '@framework/q',
          ['w', 'w2', 'w3', 'w4'].map(w => ships(w, '@framework/q'))
        ),
      ]);
      p.seed('@framework/p', [
        at('1.0.0', '@framework/p', [ships('a', '@framework/p'), ships('b', '@framework/p')]),
      ]);

      await p.runInit();

      expect(rowsOf(core)).toEqual([
        '1.2.0:skip:[a]',
        '1.1.0:share:[w,w2,w3,w4,b]',
        '1.0.0:skip:[r]',
      ]);
      expect(verdicts()).toEqual([]);
    });

    describe('a subpool the extension serves', () => {
      // w, w2 and w3 elect core + forms. a and r ship core + animations instead, so a later round places r in
      // a's subpool; both agree with round 1 and ship animations at one tag, so the extension then publishes
      // it.
      const seedPortfolio = (coreAlso: CopySpec[] = []) => {
        p.seed('@framework/core', [
          at('17.0.0', '@framework/core', [
            copy('w', '^17.0.0'),
            copy('w2', '^17.0.0'),
            copy('w3', '^17.0.0'),
            copy('a', '^17.0.0'),
            copy('r', '^17.0.0'),
            ...coreAlso,
          ]),
        ]);
        p.seed('@framework/forms', [
          at('17.0.0', '@framework/forms', [
            copy('w', '^17.0.0'),
            copy('w2', '^17.0.0'),
            copy('w3', '^17.0.0'),
          ]),
        ]);
        p.seed('@framework/animations', [
          at('17.0.0', '@framework/animations', [copy('a', '^17.0.0'), copy('r', '^17.0.0')]),
        ]);
      };

      it('moves the whole subpool onto the global map, with nothing to warn', async () => {
        seedPortfolio();

        await p.runInit();

        expect(rowsOf('@framework/animations')).toEqual(['17.0.0:share:[a,r]']);
        expect(verdicts()).toEqual([]);
        expect(p.config.log.warn).not.toHaveBeenCalled();
      });

      it('dissolves a subpool the extension leaves with its build alone', async () => {
        // a also ships cdk@17.1.0, c ships cdk@17.0.0 and their ranges keep them apart, so cdk is not
        // published: r moves global, a cannot, and a subpool of one is none.
        seedPortfolio([copy('c', '^17.0.0')]);
        p.seed('@framework/cdk', [
          at('17.1.0', '@framework/cdk', [copy('a', '~17.1.0')]),
          at('17.0.0', '@framework/cdk', [copy('c', '~17.0.0')]),
        ]);

        await p.runInit();

        expect(rowsOf('@framework/animations')).toEqual(['17.0.0:share:[a,r]']);
        expect(namesOf('@framework/cdk', 'scope')).toEqual(['a', 'c']);
        expect(verdicts()).toEqual(['a@@framework/cdk: uncovered', 'c@@framework/cdk: uncovered']);
      });

      it('keeps a subpool whose build the extension serves while another member still needs it', async () => {
        // x (core@17.0.0, ~17.0.0) is the only agreeing contributor and gets animations@17.0.0 published.
        // a runs core@17.1.0 with ^17, r pins ~17.1.0: a later round places r in a's subpool. After the
        // extension the global map would serve a (its ^17 takes 17.0.0) but not r, so the subpool moves only
        // as a whole — it stays, and a is told why it runs its own build though nothing rejects or lacks.
        p.seed('@framework/core', [
          at('17.1.0', '@framework/core', [copy('a', '^17.0.0'), copy('r', '~17.1.0')]),
          at('17.0.0', '@framework/core', [
            copy('w', '^17.0.0'),
            copy('w2', '^17.0.0'),
            copy('w3', '^17.0.0'),
            copy('x', '~17.0.0'),
          ]),
        ]);
        p.seed('@framework/forms', [
          at('17.0.0', '@framework/forms', [
            copy('w', '^17.0.0'),
            copy('w2', '^17.0.0'),
            copy('w3', '^17.0.0'),
          ]),
        ]);
        p.seed('@framework/animations', [
          at('17.0.0', '@framework/animations', [
            copy('x', '^17.0.0'),
            copy('a', '^17.0.0'),
            copy('r', '^17.0.0'),
          ]),
        ]);

        await p.runInit();

        expect(verdicts()).toEqual([
          'a@@framework/animations: served by a',
          'a@@framework/core: served by a',
          'r@@framework/animations: served by a',
          'r@@framework/core: served by a',
        ]);
        // a stays on its own core although the elected build would serve it: r still needs a's build.
        expect(rowsOf('@framework/core')).toEqual([
          '17.1.0:skip:[a,r]',
          '17.0.0:share:[w,w2,w3,x]',
        ]);
      });
    });

    it('publishes a package the winner lacks when every agreeing remote ships it at one tag', async () => {
      // Ragged: a ships core + common, b common + forms, all 17. a's build cannot serve b (no forms), but
      // b agrees with it and is the only forms provider, so forms is published from b and b runs globally.
      p.seed('@framework/core', [at('17.0.0', '@framework/core', [copy('a', '^17.0.0')])]);
      p.seed('@framework/common', [
        at('17.0.0', '@framework/common', [copy('a', '^17.0.0'), copy('b', '^17.0.0')]),
      ]);
      p.seed('@framework/forms', [at('17.0.0', '@framework/forms', [copy('b', '^17.0.0')])]);

      await p.runInit();

      expect(rowsOf('@framework/forms')).toEqual(['17.0.0:share:[b]']);
      expect(rowsOf('@framework/common')).toEqual(['17.0.0:share:[a,b]']);
      expect(verdicts()).toEqual([]);
    });
  });

  // strictExternalCompatibility refuses a range that rejects the elected build, never a coverage miss.
  describe('strict compatibility', () => {
    beforeEach(() => page({ strict: true }));

    // c's core range rejects the elected 17 (a and b make it the majority); `strict` is its strictVersion.
    const seedRejecting = (strict: boolean) => {
      p.seed('@framework/core', [
        at('17.0.0', '@framework/core', [copy('a', '^17.0.0'), copy('b', '^17.0.0')]),
        at('18.0.0', '@framework/core', [copy('c', '^18.0.0', { strict })]),
      ]);
      p.seed('@framework/common', [
        at('17.0.0', '@framework/common', [copy('a', '^17.0.0'), copy('c', '^17.0.0')]),
      ]);
    };

    it('throws when a strict range rejects the elected build, before any verdict is stored', async () => {
      seedRejecting(true);

      await expect(p.runInit()).rejects.toThrow(NFError);
      expect(p.record('@framework/core').poolName).toBeUndefined();
      expect(verdicts()).toEqual([]);
    });

    it('does not throw when the rejecting range is not strict', async () => {
      seedRejecting(false);

      await p.runInit();

      expect(p.islands()).toEqual({ c: 'incompatible' });
    });

    it('throws when any rejecting copy is strict, whichever member is read first', async () => {
      // c rejects the elected 17 on both members, but only its core range is strict. common comes first in
      // the pool, so judging only c's first rejection would read a non-strict one and island c silently.
      p.seed('@framework/common', [
        at('17.0.0', '@framework/common', [copy('a', '^17.0.0'), copy('b', '^17.0.0')]),
        at('18.0.0', '@framework/common', [copy('c', '^18.0.0', { strict: false })]),
      ]);
      p.seed('@framework/core', [
        at('17.0.0', '@framework/core', [copy('a', '^17.0.0'), copy('b', '^17.0.0')]),
        at('18.0.0', '@framework/core', [copy('c', '^18.0.0', { strict: true })]),
      ]);

      await expect(p.runInit()).rejects.toThrow(NFError);
      expect(p.config.log.error).toHaveBeenCalledWith(3, expect.stringContaining('{c}'));
    });

    it('does not throw when a remote misses round 1 for lack of coverage', async () => {
      // a's build serves the common-consuming majority. c and d agree with it but ship cdk at two tags their
      // ranges keep apart, so cdk is not published and neither serves the other: a coverage miss for both,
      // nothing to refuse.
      seedCoverageMiss();

      await p.runInit();

      expect(verdicts()).toEqual(['c@@framework/cdk: uncovered', 'd@@framework/cdk: uncovered']);
    });
  });

  // What pooling stores for tools to read: the pool an external is in (`SharedExternal.poolName`) and, per
  // scoped copy, why it self-serves (`poolCause`). See docs/version-resolver.md §"What pooling stores".
  describe('stored pool state', () => {
    // mfe3 is islanded on core@18 and ships the matching common@17 too; mfe2 makes 17 the majority.
    const seedIslanding = () => {
      p.seed('@framework/core', [
        at(
          '17.0.0',
          '@framework/core',
          [copy('mfe1', '^17.0.0'), copy('mfe2', '^17.0.0')],
          'share'
        ),
        at('18.0.0', '@framework/core', [copy('mfe3', '^18.0.0')], 'scope'),
      ]);
      p.seed('@framework/common', [
        at(
          '17.0.0',
          '@framework/common',
          [copy('mfe1', '^17.0.0'), copy('mfe3', '^17.0.0')],
          'share'
        ),
      ]);
    };

    it('writes the pool name and round-1 winner onto every rebuilt member', async () => {
      seedIslanding();

      await p.runInit();

      for (const name of ['@framework/core', '@framework/common']) {
        expect(p.record(name).poolName).toBe('framework');
        expect(p.record(name).poolWinner).toBe('mfe1');
      }
    });

    it("marks every copy of an islanded remote 'incompatible', and no clean copy", async () => {
      seedIslanding();

      await p.runInit();

      // Including common@17, which matched the winner: it is scoped because of core, not itself.
      expect(causeOf('@framework/core', 'mfe3')).toBe('incompatible');
      expect(causeOf('@framework/common', 'mfe3')).toBe('incompatible');
      expect(causeOf('@framework/core', 'mfe1')).toBeUndefined();
      expect(causeOf('@framework/common', 'mfe1')).toBeUndefined();
    });

    it("marks a remote that misses round 1 for lack of coverage 'uncovered'", async () => {
      seedCoverageMiss();

      await p.runInit();

      expect(causeOf('@framework/cdk', 'c')).toBe('uncovered');
      // Its core is the elected tag and it agrees, so that copy resolves globally with no cause.
      expect(causeOf('@framework/core', 'c')).toBeUndefined();
    });

    it('clears a stale poolCause on a re-election that otherwise needs nothing', async () => {
      // A healthy pool, but the record still says mfe2 self-served last time.
      p.seed('@framework/core', [
        withState(at('17.0.0', '@framework/core', [copy('mfe1'), copy('mfe2')], 'share'), 'mfe2', {
          poolCause: 'uncovered',
        }),
      ]);
      p.seed('@framework/common', [
        at('17.0.0', '@framework/common', [copy('mfe1'), copy('mfe2')], 'share'),
      ]);

      await p.runInit();

      expect(causeOf('@framework/core', 'mfe2')).toBeUndefined();
      expect(namesOf('@framework/core', 'share')).toEqual(['mfe1', 'mfe2']);
    });

    it('clears a stale subpool and poolCause off a pool that shrank to one remote', async () => {
      // H redeployed without the family, so only R is left. R's copies still carry the verdicts the
      // two-remote pool gave them: H's subpool (whose files are gone) and an island cause.
      p.seed('@framework/core', [
        withState(at('17.0.0', '@framework/core', [copy('R')], 'share'), 'R', { servedBy: 'H' }),
      ]);
      p.seed('@framework/common', [
        withState(at('17.0.0', '@framework/common', [copy('R')], 'share'), 'R', {
          poolCause: 'uncovered',
        }),
      ]);

      await p.runInit();

      expect(verdicts()).toEqual([]);
      expect(namesOf('@framework/core', 'share')).toEqual(['R']);
      expect(namesOf('@framework/common', 'share')).toEqual(['R']);
      expect(p.record('@framework/core').poolName).toBe('framework');
    });

    it('writes a healthy re-election back exactly as stored', async () => {
      const stored = { poolName: 'framework', poolWinner: 'mfe1' };
      for (const name of ['@framework/core', '@framework/common'])
        p.seed(name, [at('17.0.0', name, [copy('mfe1'), copy('mfe2')], 'share')], true, stored);
      const seeded = { core: decided('@framework/core'), common: decided('@framework/common') };

      await p.runInit();

      expect(decided('@framework/core')).toEqual(seeded.core);
      expect(decided('@framework/common')).toEqual(seeded.common);
    });
  });
});
