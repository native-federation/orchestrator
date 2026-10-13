import fc from 'fast-check';
import { compareStrings } from 'lib/utils/compare-strings';
import { addRemoteToVersion } from './basis';
import { claimTable } from './claims';
import type { AcceptsTag } from './compatibility';
import type { ExternalName, SharedExternal } from './external.contract';
import {
  byServingRank,
  followServingBuild,
  packagesOf,
  resolvesAtServingTag,
  servingBuildOf,
  type ServingBuild,
  type ServingCandidate,
} from './serving';
import type { SharedVersion, SharedVersionAction, SharedVersionMeta } from './version.contract';

const copy = (name: string, entries: string[], extra: Partial<SharedVersionMeta> = {}) =>
  ({
    name,
    requiredVersion: '^1.0.0',
    strictVersion: false,
    cached: false,
    entries: Object.fromEntries(entries.map(e => [e, `${e.replace(/\//g, '-')}.js`])),
    ...extra,
  }) satisfies SharedVersionMeta;

const version = (
  action: SharedVersionAction,
  remotes: SharedVersionMeta[],
  tag = '1.0.0',
  host = false
): SharedVersion => ({ tag, host, action, remotes });

const external = (...versions: SharedVersion[]): SharedExternal => ({ dirty: false, versions });

// Same major, or the copy's own tag: enough semver for these fixtures.
const accepts: AcceptsTag = (offered, ownTag, requiredVersion) =>
  offered === ownTag || offered.split('.')[0] === requiredVersion.replace(/^\^/, '').split('.')[0];

const serving = (...externals: [ExternalName, SharedExternal][]) =>
  servingBuildOf(externals, accepts);

describe('byServingRank', () => {
  const candidate = (extra: Partial<ServingCandidate>): ServingCandidate => ({
    remote: 'r',
    tag: '1.0.0',
    host: false,
    downloads: 0,
    fallbacks: 0,
    rootBasis: false,
    ...extra,
  });

  it('orders by host, downloads, fallbacks, root basis, then name', () => {
    const ranked = [
      candidate({ remote: 'a', downloads: 1 }),
      candidate({ remote: 'b', rootBasis: true }),
      candidate({ remote: 'c', host: true, downloads: 9 }),
      candidate({ remote: 'd', fallbacks: 1 }),
      candidate({ remote: 'e' }),
      candidate({ remote: 'B' }),
    ].sort(byServingRank);

    expect(ranked.map(c => c.remote)).toEqual(['c', 'b', 'B', 'e', 'd', 'a']);
  });

  it('compares names by code unit, so upper case sorts before lower case', () => {
    expect(byServingRank(candidate({ remote: 'Z' }), candidate({ remote: 'a' }))).toBeLessThan(0);
  });
});

describe('packagesOf', () => {
  it('groups secondary entrypoints with their package, in record order', () => {
    const scope = {
      'fw/testing': external(),
      rxjs: external(),
      fw: external(),
      '@scope/ui/table': external(),
      'rxjs/operators': external(),
    };

    expect([...packagesOf(scope)]).toEqual([
      ['fw', ['fw/testing', 'fw']],
      ['rxjs', ['rxjs', 'rxjs/operators']],
      ['@scope/ui', ['@scope/ui/table']],
    ]);
  });
});

describe('servingBuildOf', () => {
  it('serves a dense root and its flat secondary at the same tag from one build', () => {
    const result = serving(
      ['fw', external(version('share', [copy('r1', ['fw', 'fw/testing']), copy('r2', ['fw'])]))],
      ['fw/testing', external(version('share', [copy('r2', ['fw/testing'])]))]
    );

    expect(result).toEqual<ServingBuild>({ remote: 'r1', tag: '1.0.0' });
  });

  it("takes the tag from the root's share row over a secondary's share row at another tag", () => {
    // r2 alone would be cheaper (r1 is not cached), but it only shares the secondary.
    const result = serving(
      ['fw', external(version('share', [copy('r1', ['fw'])]))],
      [
        'fw/testing',
        external(version('share', [copy('r2', ['fw/testing'], { cached: true })], '2.0.0')),
      ]
    );

    expect(result).toEqual<ServingBuild>({ remote: 'r1', tag: '1.0.0' });
  });

  it('ranks a package that has secondary entrypoints only across their tags', () => {
    const result = serving(
      ['ui/table', external(version('share', [copy('r1', ['ui/table'])], '1.0.0'))],
      ['ui/sort', external(version('share', [copy('r2', ['ui/sort'], { cached: true })], '2.0.0'))]
    );

    // r2 is already downloaded; r1 would cost a download.
    expect(result).toEqual<ServingBuild>({ remote: 'r2', tag: '2.0.0' });
  });

  describe('a pooled package', () => {
    const pooled = (winner: string | undefined, ...versions: SharedVersion[]): SharedExternal => ({
      ...external(...versions),
      poolName: 'team',
      ...(winner ? { poolWinner: winner } : {}),
    });

    it("takes its pool winner's build, unranked, even when another copy is cached", () => {
      const result = serving([
        'fw',
        pooled(
          'winner',
          version('share', [copy('member', ['fw'], { cached: true }), copy('winner', ['fw'])])
        ),
      ]);

      expect(result).toEqual<ServingBuild>({ remote: 'winner', tag: '1.0.0' });
    });

    it("takes the winner's tag from any share row of a package without a root", () => {
      const result = serving(
        ['fw/a', pooled('r2', version('skip', [copy('r1', ['fw/a'])]))],
        ['fw/b', pooled('r2', version('share', [copy('r2', ['fw/b'])], '2.0.0'))],
        ['fw/c', external(version('share', [copy('r3', ['fw/c'], { cached: true })], '3.0.0'))]
      );

      expect(result).toEqual<ServingBuild>({ remote: 'r2', tag: '2.0.0' });
    });

    // The election publishes a package its winner does not ship from one copy, which contains every other
    // global copy; the widest copy is that one, or one with the same entrypoints.
    it('takes the widest copy when its winner ships none of it, or there is no winner', () => {
      const shipped = version('share', [
        copy('narrow', ['fw']),
        copy('wide', ['fw', 'fw/a']),
        copy('tied', ['fw']),
      ]);

      expect(serving(['fw', pooled('elsewhere', shipped)])).toEqual({
        remote: 'wide',
        tag: '1.0.0',
      });
      expect(serving(['fw', pooled(undefined, shipped)])).toEqual({ remote: 'wide', tag: '1.0.0' });
    });

    it('counts the entrypoints a copy ships in every share row of the package, and breaks a tie by name', () => {
      const result = serving(
        ['fw', pooled('elsewhere', version('share', [copy('y', ['fw']), copy('x', ['fw'])]))],
        ['fw/a', pooled('elsewhere', version('share', [copy('x', ['fw/a']), copy('y', ['fw/a'])]))],
        ['fw/b', pooled('elsewhere', version('share', [copy('y', ['fw/b'])]))]
      );

      expect(result).toEqual<ServingBuild>({ remote: 'y', tag: '1.0.0' });
      expect(
        serving(['fw', pooled(undefined, version('share', [copy('y', ['fw']), copy('x', ['fw'])]))])
      ).toEqual<ServingBuild>({ remote: 'x', tag: '1.0.0' });
    });

    it("takes the root's build when the winner ships only a flat secondary beside it", () => {
      // Seeding the winner would run the root from one build and the secondary from another.
      const result = serving(
        ['fw', pooled('winner', version('share', [copy('member', ['fw', 'fw/testing'])]))],
        ['fw/testing', pooled('winner', version('share', [copy('winner', ['fw/testing'])]))]
      );

      expect(result).toEqual<ServingBuild>({ remote: 'member', tag: '1.0.0' });
    });

    it("ignores a winner's copy that runs another build", () => {
      const result = serving([
        'fw',
        pooled(
          'winner',
          version('share', [copy('member', ['fw']), copy('winner', ['fw'], { servedBy: 'other' })])
        ),
      ]);

      expect(result).toEqual<ServingBuild>({ remote: 'member', tag: '1.0.0' });
    });

    it('is pooled when only a secondary carries the pool name', () => {
      // Ranked, the cached copy would serve: it costs no download.
      const result = serving(
        [
          'fw',
          external(
            version('share', [copy('basis', ['fw']), copy('cached', ['fw'], { cached: true })])
          ),
        ],
        ['fw/a', pooled('basis', version('share', [copy('basis', ['fw/a'])]))]
      );

      expect(result).toEqual<ServingBuild>({ remote: 'basis', tag: '1.0.0' });
    });
  });

  it('serves the host over a cached build', () => {
    const result = serving([
      'fw',
      external(
        version('share', [copy('host', ['fw'])], '1.0.0', true),
        version('share', [copy('cached', ['fw'], { cached: true })], '1.1.0')
      ),
    ]);

    expect(result).toEqual<ServingBuild>({ remote: 'host', tag: '1.0.0' });
  });

  it("takes the package from the root's build for a host shipping only a flat secondary beside a remote's dense root", () => {
    const externals: [ExternalName, SharedExternal][] = [
      ['fw', external(version('share', [copy('remote', ['fw', 'fw/testing'])], '2.0.0'))],
      ['fw/testing', external(version('share', [copy('host', ['fw/testing'])], '1.0.0', true))],
    ];
    const build = serving(...externals)!;
    for (const [, e] of externals) e.servingBuild = build.remote;

    expect(build).toEqual<ServingBuild>({ remote: 'remote', tag: '2.0.0' });
    // The host's own row follows the root's build, so the host runs the whole package from it.
    expect(resolvesAtServingTag(externals, build, 'fw/testing')).toBe(true);
    expect(claimTable(externals).claims.get('fw/testing')?.copy.name).toBe('remote');
  });

  it('serves a cached build over an uncached one, the root basis included', () => {
    const result = serving([
      'fw',
      external(version('share', [copy('basis', ['fw']), copy('cached', ['fw'], { cached: true })])),
    ]);

    expect(result).toEqual<ServingBuild>({ remote: 'cached', tag: '1.0.0' });
  });

  it('prices a strict consumer that rejects the tag as a download, a non-strict one as free', () => {
    const record = (strictVersion: boolean): [ExternalName, SharedExternal] => [
      'fw',
      external(
        version('share', [copy('r2', ['fw'], { requiredVersion: '^2.0.0' })], '2.0.0'),
        version('share', [copy('r1', ['fw'])], '1.0.0'),
        version('skip', [copy('c', ['fw'], { requiredVersion: '^2.0.0', strictVersion })], '2.1.0')
      ),
    ];

    // Strict: serving r1 also downloads c's own build (2), serving r2 does not (1).
    expect(serving(record(true))).toEqual<ServingBuild>({ remote: 'r2', tag: '2.0.0' });
    // Non-strict: c takes whatever is shared, both cost 1 and the name decides.
    expect(serving(record(false))).toEqual<ServingBuild>({ remote: 'r1', tag: '1.0.0' });
  });

  it('prices a consumer that runs a copy from a scope row as a download', () => {
    // Serving the cached a still downloads c's scoped build, so a and c tie at 1 and c is the root basis.
    // Unpriced, a would win at 0.
    const result = serving(
      ['fw', external(version('share', [copy('c', ['fw']), copy('a', ['fw'], { cached: true })]))],
      ['fw/testing', external(version('scope', [copy('c', ['fw/testing'])], '2.0.0'))]
    );

    expect(result).toEqual<ServingBuild>({ remote: 'c', tag: '1.0.0' });
  });

  it('breaks an equal rank by name, not by record order', () => {
    const tie = (first: string, second: string) =>
      serving(
        ['fw/a', external(version('share', [copy(first, ['fw/a'])], '1.0.0'))],
        ['fw/b', external(version('share', [copy(second, ['fw/b'])], '2.0.0'))]
      );

    expect(tie('m', 'k')).toEqual<ServingBuild>({ remote: 'k', tag: '2.0.0' });
    expect(tie('k', 'm')).toEqual<ServingBuild>({ remote: 'k', tag: '1.0.0' });
  });

  it('never serves a copy pooling placed on another build', () => {
    const result = serving([
      'fw',
      external(
        version('share', [
          copy('subpool', ['fw'], { servedBy: 'other', cached: true }),
          copy('basis', ['fw']),
        ])
      ),
    ]);

    expect(result).toEqual<ServingBuild>({ remote: 'basis', tag: '1.0.0' });
  });

  it('serves nothing without a share row', () => {
    expect(serving(['fw', external(version('skip', [copy('r1', ['fw'])]))])).toBeUndefined();
    expect(serving()).toBeUndefined();
  });

  // Rows are built the way registration builds them (`addRemoteToVersion`), in a shuffled remote order, so the
  // basis each row ends up with (host, cached, coverage, then name) is what decides, not insertion order.
  it('ignores the order remotes register in, and of externals and rows (unpooled)', () => {
    const secondaries = ['fw/a', 'fw/b'];
    const tags = ['1.0.0', '2.0.0'];
    const actions: SharedVersionAction[] = ['share', 'share', 'skip', 'scope'];

    // One build ships one tag of the package: dense lists its secondaries as entries of the root's copy, flat
    // ships each as an external of its own.
    const build = fc.record({
      tag: fc.constantFrom(...tags),
      root: fc.boolean(),
      ships: fc.subarray(secondaries),
      dense: fc.boolean(),
      action: fc.constantFrom(...actions),
      cached: fc.boolean(),
      strictVersion: fc.boolean(),
      requiredVersion: fc.constantFrom('^1.0.0', '^2.0.0'),
      host: fc.boolean(),
    });
    type Build = typeof build extends fc.Arbitrary<infer T> ? T : never;
    const portfolio = fc
      .dictionary(fc.constantFrom('r1', 'r2', 'r3', 'r4', 'R5'), build, { minKeys: 1 })
      .filter(builds => Object.values(builds).some(b => b.root || b.ships.length > 0))
      .chain(builds => {
        const remotes = Object.keys(builds);
        const permutation = { minLength: remotes.length, maxLength: remotes.length };
        return fc.tuple(
          fc.constant(builds),
          fc.shuffledSubarray(remotes, permutation),
          fc.shuffledSubarray(remotes, permutation),
          fc.integer()
        );
      });

    // The page has at most one host: the first flagged remote by name, whatever the order.
    const hostOf = (builds: Record<string, Build>) =>
      Object.keys(builds)
        .filter(name => builds[name]!.host)
        .sort(compareStrings)[0];

    const toRecord = (builds: Record<string, Build>, order: string[]) => {
      const host = hostOf(builds);
      const record = new Map<ExternalName, SharedExternal>();
      const add = (ext: ExternalName, b: Build, remote: string, entries: string[]) => {
        const e = record.get(ext) ?? external();
        record.set(ext, e);
        let row = e.versions.find(v => v.tag === b.tag && v.action === b.action);
        if (!row) e.versions.push((row = version(b.action, [], b.tag)));
        const { cached, strictVersion, requiredVersion } = b;
        addRemoteToVersion(
          row,
          copy(remote, entries, { cached, strictVersion, requiredVersion }),
          remote === host
        );
      };
      for (const remote of order) {
        const b = builds[remote]!;
        if (b.root) add('fw', b, remote, b.dense ? ['fw', ...b.ships] : ['fw']);
        if (!(b.root && b.dense)) for (const ext of b.ships) add(ext, b, remote, [ext]);
      }
      return [...record];
    };

    fc.assert(
      fc.property(portfolio, ([builds, first, second, seed]) => {
        const shuffle = <T>(items: T[], salt: number) =>
          items
            .map((item, i) => ({ item, key: Math.sin(seed + salt * 31 + i) }))
            .sort((a, b) => a.key - b.key)
            .map(({ item }) => item);
        const shuffled = shuffle(toRecord(builds, second), 0).map(
          ([name, e], i) =>
            [name, { ...e, versions: shuffle(e.versions, i + 1) }] as [ExternalName, SharedExternal]
        );

        expect(servingBuildOf(shuffled, accepts)).toEqual(
          servingBuildOf(toRecord(builds, first), accepts)
        );
      }),
      { seed: 20261013, numRuns: 1000 }
    );
  });
});

describe('resolvesAtServingTag', () => {
  const toServing: ServingBuild = { remote: 'serving', tag: '2.0.0' };
  const root: [ExternalName, SharedExternal] = [
    'fw',
    external(version('share', [copy('serving', ['fw', 'fw/shipped'])], '2.0.0')),
  ];

  it('holds for an external with a share row at the serving tag, whoever ships it', () => {
    const testing: [ExternalName, SharedExternal] = [
      'fw/testing',
      external(
        version('share', [copy('other', ['fw/testing'])], '2.0.0'),
        version('share', [copy('old', ['fw/testing'])], '1.0.0')
      ),
    ];

    expect(resolvesAtServingTag([root, testing], toServing, 'fw/testing')).toBe(true);
  });

  it("holds for an external the serving build ships in another external's share row", () => {
    const shipped: [ExternalName, SharedExternal] = [
      'fw/shipped',
      external(version('share', [copy('old', ['fw/shipped'])], '1.0.0')),
    ];

    expect(resolvesAtServingTag([root, shipped], toServing, 'fw/shipped')).toBe(true);
  });

  it('fails for an external with neither', () => {
    const testing: [ExternalName, SharedExternal] = [
      'fw/testing',
      external(
        version('share', [copy('old', ['fw/testing'])], '1.0.0'),
        // Only a share row counts: a skip row at the serving tag publishes nothing.
        version('skip', [copy('serving', ['fw/testing'])], '2.0.0')
      ),
    ];

    expect(resolvesAtServingTag([root, testing], toServing, 'fw/testing')).toBe(false);
  });
});

describe('followServingBuild', () => {
  // `tag:action:[remotes]`, the way the pooling specs read a record.
  const shape = (e: SharedExternal) =>
    e.versions.map(v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name)}]`);
  const toServing: ServingBuild = { remote: 'serving', tag: '2.0.0' };
  const strict = { strictVersion: true };

  it('scopes a share row whose copies all reject the serving tag strictly, and reports one', () => {
    const objector = copy('a', ['fw'], strict);
    const record = external(
      version('share', [copy('serving', ['fw'], { requiredVersion: '^2.0.0' })], '2.0.0'),
      version('share', [objector], '1.0.0')
    );

    const result = followServingBuild(record, toServing, accepts);

    expect(shape(result.external)).toEqual(['2.0.0:share:[serving]', '1.0.0:scope:[a]']);
    expect(result.objector).toEqual({ copy: objector, tag: '1.0.0' });
    expect(result.external).toBe(record);
  });

  it('skips a share row whose copies accept the serving tag or are not strict', () => {
    const record = external(
      version('share', [copy('serving', ['fw'], { requiredVersion: '^2.0.0' })], '2.0.0'),
      version(
        'share',
        [
          copy('lenient', ['fw']),
          copy('accepting', ['fw'], { ...strict, requiredVersion: '^2.0.0' }),
        ],
        '1.0.0'
      )
    );

    const result = followServingBuild(record, toServing, accepts);

    expect(shape(result.external)).toEqual([
      '2.0.0:share:[serving]',
      '1.0.0:skip:[lenient,accepting]',
    ]);
    expect(result.objector).toBeUndefined();
  });

  it('splits a mixed share row and merges the split into an existing row of its tag', () => {
    const record = external(
      version('share', [copy('serving', ['fw'], { requiredVersion: '^2.0.0' })], '2.0.0'),
      version('share', [copy('lenient', ['fw']), copy('a', ['fw'], strict)], '1.0.0'),
      version('scope', [copy('b', ['fw'], strict)], '1.0.0')
    );

    const result = followServingBuild(record, toServing, accepts);

    expect(shape(result.external)).toEqual([
      '2.0.0:share:[serving]',
      '1.0.0:skip:[lenient]',
      '1.0.0:scope:[a,b]',
    ]);
    expect(result.objector?.copy.name).toBe('a');
  });

  it('reports the first objector in record order', () => {
    const record = external(
      version('share', [copy('first', ['fw'], { ...strict, requiredVersion: '^3.0.0' })], '3.0.0'),
      version('share', [copy('serving', ['fw'], { requiredVersion: '^2.0.0' })], '2.0.0'),
      version('share', [copy('second', ['fw'], strict)], '1.0.0')
    );

    const result = followServingBuild(record, toServing, accepts);

    expect(shape(result.external)).toEqual([
      '3.0.0:scope:[first]',
      '2.0.0:share:[serving]',
      '1.0.0:scope:[second]',
    ]);
    expect(result.objector).toEqual({
      copy: expect.objectContaining({ name: 'first' }),
      tag: '3.0.0',
    });
  });

  it('leaves share rows at the serving tag, and skip and scope rows, untouched', () => {
    const rows = [
      version('share', [copy('serving', ['fw'], { requiredVersion: '^2.0.0' })], '2.0.0'),
      version('skip', [copy('other', ['fw'], strict)], '2.0.0'),
      version('skip', [copy('skipped', ['fw'], strict)], '1.0.0'),
      version('scope', [copy('scoped', ['fw/testing'])], '1.0.0'),
    ];
    const record = external(...rows.map(row => ({ ...row, remotes: [...row.remotes] })));

    const result = followServingBuild(record, toServing, accepts);

    expect(result.external.versions).toEqual(rows);
    expect(result.objector).toBeUndefined();
  });
});
