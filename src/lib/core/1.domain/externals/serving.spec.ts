import fc from 'fast-check';
import type { AcceptsTag } from './compatibility';
import type { ExternalName, SharedExternal } from './external.contract';
import {
  byServingRank,
  packagesOf,
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

  it("gives a pooled package its root row's basis even when another copy is cached", () => {
    const result = serving([
      'fw',
      {
        ...external(
          version('share', [copy('winner', ['fw']), copy('member', ['fw'], { cached: true })])
        ),
        poolName: 'team',
      },
    ]);

    expect(result).toEqual<ServingBuild>({ remote: 'winner', tag: '1.0.0' });
  });

  it("falls back to a pooled package's first share row in record order without a root", () => {
    const result = serving(
      ['fw/a', { ...external(version('skip', [copy('r1', ['fw/a'])])), poolName: 'team' }],
      [
        'fw/b',
        { ...external(version('share', [copy('r2', ['fw/b'])], '2.0.0')), poolName: 'team' },
      ],
      ['fw/c', external(version('share', [copy('r3', ['fw/c'], { cached: true })], '3.0.0'))]
    );

    expect(result).toEqual<ServingBuild>({ remote: 'r2', tag: '2.0.0' });
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

  it('ignores the order of externals and of rows (unpooled)', () => {
    const names = ['fw', 'fw/a', 'fw/b'];
    const tags = ['1.0.0', '2.0.0'];
    const actions: SharedVersionAction[] = ['share', 'share', 'skip', 'scope'];

    // One build ships one tag of the package, so each remote picks a tag and the externals it ships.
    const build = fc.record({
      tag: fc.constantFrom(...tags),
      ships: fc.subarray(names, { minLength: 1 }),
      action: fc.constantFrom(...actions),
      cached: fc.boolean(),
      strictVersion: fc.boolean(),
      requiredVersion: fc.constantFrom('^1.0.0', '^2.0.0'),
    });
    const portfolio = fc.dictionary(fc.constantFrom('r1', 'r2', 'r3', 'r4', 'R5'), build, {
      minKeys: 1,
    });

    type Build = typeof build extends fc.Arbitrary<infer T> ? T : never;
    const toRecord = (builds: Record<string, Build>) => {
      const record = new Map<ExternalName, SharedExternal>();
      for (const [name, b] of Object.entries(builds))
        for (const ext of b.ships) {
          const e = record.get(ext) ?? external();
          record.set(ext, e);
          let row = e.versions.find(v => v.tag === b.tag && v.action === b.action);
          if (!row) e.versions.push((row = version(b.action, [], b.tag)));
          const { cached, strictVersion, requiredVersion } = b;
          row.remotes.push(copy(name, [ext], { cached, strictVersion, requiredVersion }));
        }
      return [...record];
    };

    fc.assert(
      fc.property(portfolio, fc.integer(), (builds, seed) => {
        const record = toRecord(builds);
        const shuffle = <T>(items: T[], salt: number) =>
          items
            .map((item, i) => ({ item, key: Math.sin(seed + salt * 31 + i) }))
            .sort((a, b) => a.key - b.key)
            .map(({ item }) => item);
        const shuffled = shuffle(record, 0).map(
          ([name, e], i) =>
            [name, { ...e, versions: shuffle(e.versions, i + 1) }] as [ExternalName, SharedExternal]
        );

        expect(servingBuildOf(shuffled, accepts)).toEqual(servingBuildOf(record, accepts));
      }),
      { seed: 20261013, numRuns: 500 }
    );
  });
});
