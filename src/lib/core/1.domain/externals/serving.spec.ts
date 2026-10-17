import fc from 'fast-check';
import { compareStrings } from 'lib/utils/compare-strings';
import { addRemoteToVersion } from './basis';
import { claimTable } from './claims';
import type { AcceptsTag } from './compatibility';
import type { ExternalName, SharedExternal } from './external.contract';
import {
  byServingRank,
  consumersOf,
  costTable,
  fallbacksOf,
  followServingBuild,
  packagesOf,
  SCANNED_SURFACES_PER_TAG,
  servingBuildOf,
  shareServingCopies,
  strictObjectorOf,
  strictTagScopes,
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

// Same major, any tag for `*`, or the copy's own tag: enough semver for these fixtures.
const accepts: AcceptsTag = (offered, ownTag, requiredVersion) =>
  offered === ownTag ||
  requiredVersion === '*' ||
  offered.split('.')[0] === requiredVersion.replace(/^\^/, '').split('.')[0];

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
      [
        'ui/sort',
        external(
          version('share', [copy('r2', ['ui/sort', 'ui/table'], { cached: true })], '2.0.0')
        ),
      ]
    );

    // r2 is already downloaded and covers r1; r1 would cost a download and leave r2 on its own build.
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

  // The host's copy lacks fw/x, so serving it sends a and b to their own builds: two more downloads and two
  // fallbacks than serving a. The host still wins, so the other candidates need no pricing.
  it('serves the host over a build that costs fewer downloads and fallbacks', () => {
    const result = serving([
      'fw',
      external(
        version(
          'share',
          [copy('host', ['fw']), copy('a', ['fw', 'fw/x']), copy('b', ['fw', 'fw/x'])],
          '1.0.0',
          true
        )
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
    // The root's build covers the host's copy, so the host runs the whole package from it.
    expect(fallbacksOf(externals, build, accepts)).toEqual([]);
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
      ['fw/testing', external(version('scope', [copy('c', ['fw/testing'])]))]
    );

    expect(result).toEqual<ServingBuild>({ remote: 'c', tag: '1.0.0' });
  });

  describe('a copy the serving build does not cover', () => {
    // b ships fw/testing, which a's build at 1.0.0 lacks.
    const uncovered = (cachedA = false, cachedB = false): [ExternalName, SharedExternal][] => [
      [
        'fw',
        external(
          version('share', [
            copy('a', ['fw'], { cached: cachedA }),
            copy('b', ['fw'], { cached: cachedB }),
          ])
        ),
      ],
      ['fw/testing', external(version('skip', [copy('b', ['fw/testing'], { cached: cachedB })]))],
    ];

    it("prices the copy's own build as a download", () => {
      // Serving the cached a still loads b's own build (1), as serving b does; unpriced, a would win at 0.
      expect(serving(...uncovered(true))).toEqual<ServingBuild>({ remote: 'b', tag: '1.0.0' });
    });

    it('ranks the build that covers it first when the downloads tie', () => {
      // All cached: both cost nothing, and the name alone would pick a.
      expect(serving(...uncovered(true, true))).toEqual<ServingBuild>({
        remote: 'b',
        tag: '1.0.0',
      });
    });

    it("falls back for a specifier outside the serving build's copies at the serving tag", () => {
      expect(fallbacksOf(uncovered(), { remote: 'a', tag: '1.0.0' }, accepts)).toEqual(['b']);
      expect(fallbacksOf(uncovered(), { remote: 'b', tag: '1.0.0' }, accepts)).toEqual([]);
    });

    it("counts only the serving build's copies at the serving tag as covering", () => {
      const externals: [ExternalName, SharedExternal][] = [
        ['fw', external(version('share', [copy('a', ['fw'])], '2.0.0'))],
        [
          'fw/testing',
          external(
            version('skip', [copy('a', ['fw/testing'])], '1.0.0'),
            version('share', [copy('b', ['fw/testing'])], '1.0.0')
          ),
        ],
      ];

      expect(fallbacksOf(externals, { remote: 'a', tag: '2.0.0' }, accepts)).toEqual(['b']);
    });

    // The global map never publishes the serving build's scope copy: B maps it in its own scope only.
    it("never counts the serving build's scope copies as covering", () => {
      const externals: [ExternalName, SharedExternal][] = [
        ['fw', external(version('share', [copy('a', ['fw'])]))],
        [
          'fw/testing',
          external(
            version('share', [copy('b', ['fw/testing'])], '0.9.0'),
            version('scope', [copy('a', ['fw/testing'])])
          ),
        ],
      ];

      expect(fallbacksOf(externals, { remote: 'a', tag: '1.0.0' }, accepts)).toEqual(['b']);
    });

    it('leaves a copy that already runs from a scope row out', () => {
      const externals: [ExternalName, SharedExternal][] = [
        ['fw', external(version('share', [copy('a', ['fw'])]))],
        ['fw/testing', external(version('scope', [copy('b', ['fw/testing'])], '0.9.0'))],
      ];

      expect(fallbacksOf(externals, { remote: 'a', tag: '1.0.0' }, accepts)).toEqual([]);
    });
  });

  // b's own fw/testing election left its copy on a scope row, while its fw follows the map.
  describe('a remote that runs part of the package off the map and part on it', () => {
    it('falls back while its root would follow the serving build', () => {
      const externals: [ExternalName, SharedExternal][] = [
        [
          'fw',
          external(
            version('share', [copy('a', ['fw'])], '2.0.0'),
            version('skip', [copy('b', ['fw'])])
          ),
        ],
        ['fw/testing', external(version('scope', [copy('b', ['fw/testing'])]))],
      ];

      expect(fallbacksOf(externals, { remote: 'a', tag: '2.0.0' }, accepts)).toEqual(['b']);
    });

    it('falls back although the serving build covers the secondary', () => {
      const externals: [ExternalName, SharedExternal][] = [
        ['fw', external(version('share', [copy('a', ['fw', 'fw/testing']), copy('b', ['fw'])]))],
        ['fw/testing', external(version('scope', [copy('b', ['fw/testing'])]))],
      ];

      expect(fallbacksOf(externals, { remote: 'a', tag: '1.0.0' }, accepts)).toEqual(['b']);
    });

    it('ranks the build that keeps it whole first when the downloads tie', () => {
      // All cached: serving a makes b a fallback, serving b leaves a whole. Uncounted, a would win as the root
      // basis.
      const result = serving(
        [
          'fw',
          external(
            version('share', [
              copy('a', ['fw'], { cached: true }),
              copy('b', ['fw'], { cached: true }),
            ])
          ),
        ],
        ['fw/testing', external(version('scope', [copy('b', ['fw/testing'], { cached: true })]))]
      );

      expect(result).toEqual<ServingBuild>({ remote: 'b', tag: '1.0.0' });
    });

    it('never counts a candidate as its own fallback or prices its own build twice', () => {
      // b itself splits fw/testing off the map. Serving b costs b's build alone and leaves a whole; serving a
      // also costs b's, which falls back. Counted against itself, b would tie a and lose as the second copy.
      const externals: [ExternalName, SharedExternal][] = [
        ['fw', external(version('share', [copy('a', ['fw']), copy('b', ['fw'])]))],
        ['fw/testing', external(version('scope', [copy('b', ['fw/testing'])]))],
      ];

      expect(fallbacksOf(externals, { remote: 'b', tag: '1.0.0' }, accepts)).toEqual([]);
      expect(fallbacksOf(externals, { remote: 'a', tag: '1.0.0' }, accepts)).toEqual(['b']);
      expect(serving(...externals)).toEqual<ServingBuild>({ remote: 'b', tag: '1.0.0' });
    });
  });

  // r1 ships fw/a at 1.0.0 and fw/b at 2.0.0; no one build serves both.
  describe('a remote that ships the package at two tags', () => {
    const r1 = (action: SharedVersionAction, entry: string, tag: string) =>
      version(action, [copy('r1', [entry])], tag);
    const r2 = (entry: string) => version('share', [copy('r2', [entry])], '2.1.0');

    it('is no serving candidate', () => {
      // Both cost the same, so only the guard keeps r1, which sorts first, from serving.
      const result = serving(
        ['fw/a', external(r1('share', 'fw/a', '1.0.0'))],
        ['fw/b', external(r2('fw/b'), r1('skip', 'fw/b', '2.0.0'))]
      );

      expect(result).toEqual<ServingBuild>({ remote: 'r2', tag: '2.1.0' });
    });

    it('falls back although the serving build covers every specifier it ships', () => {
      const externals: [ExternalName, SharedExternal][] = [
        ['fw/a', external(r2('fw/a'), r1('skip', 'fw/a', '1.0.0'))],
        ['fw/b', external(r2('fw/b'), r1('skip', 'fw/b', '2.0.0'))],
      ];

      expect(fallbacksOf(externals, { remote: 'r2', tag: '2.1.0' }, accepts)).toEqual(['r1']);
    });

    it('leaves the package without a serving build when no other remote ships it', () => {
      const result = serving(
        ['fw/a', external(r1('share', 'fw/a', '1.0.0'))],
        ['fw/b', external(r1('share', 'fw/b', '2.0.0'))]
      );

      expect(result).toBeUndefined();
    });
  });

  // The host serves fw at 1.0.0 and fw/sub at 2.0.0; r1's dense copy ships both at 1.0.0, so the host covers
  // its fw/sub only at the host's other tag.
  describe("a copy that a two-tag host covers only at the host's other tag", () => {
    const externals = (
      strictVersion: boolean,
      requiredVersion = '^1.0.0'
    ): [ExternalName, SharedExternal][] => [
      [
        'fw',
        external(
          version(
            'share',
            [
              copy('host', ['fw']),
              copy('r1', ['fw', 'fw/sub'], { strictVersion, requiredVersion }),
            ],
            '1.0.0',
            true
          )
        ),
      ],
      ['fw/sub', external(version('share', [copy('host', ['fw/sub'])], '2.0.0', true))],
    ];
    const host: ServingBuild = { remote: 'host', tag: '1.0.0' };

    it('falls back when it is strict, as a runtime load of it does', () => {
      expect(fallbacksOf(externals(true), host, accepts)).toEqual(['r1']);
    });

    it('follows the host when it is loose', () => {
      expect(fallbacksOf(externals(false), host, accepts)).toEqual([]);
    });

    // r1's `*` accepts the host's fw/sub at 2.0.0, so it runs the host's files as a runtime load of it does.
    it("follows the host when it is strict and its range accepts the host's other tag", () => {
      expect(fallbacksOf(externals(true, '*'), host, accepts)).toEqual([]);
      expect(strictObjectorOf(externals(true, '*'), host, accepts)).toBeUndefined();
    });
  });

  // a serves fw at 1.0.0; b skipped onto c's fw/a 2.1.0, which its `^2.0.0` accepts, but a's fw/a 1.0.0 is
  // what serves it once that row follows the serving tag.
  describe('a strict copy whose range rejects the serving tag', () => {
    const externals = (b: SharedVersionMeta): [ExternalName, SharedExternal][] => [
      ['fw', external(version('share', [copy('a', ['fw'])]))],
      [
        'fw/a',
        external(
          version('share', [copy('c', ['fw/a'], { requiredVersion: '^2.0.0' })], '2.1.0'),
          version('skip', [b], '2.0.0'),
          version('share', [copy('a', ['fw/a'])])
        ),
      ],
    ];
    const strict = (entries: string[]) =>
      copy('b', entries, { requiredVersion: '^2.0.0', strictVersion: true });
    const a: ServingBuild = { remote: 'a', tag: '1.0.0' };

    it('falls back from a skip row, and is the objector', () => {
      const record = externals(strict(['fw/a']));

      expect(fallbacksOf(record, a, accepts)).toEqual(['b']);
      expect(strictObjectorOf(record, a, accepts)).toEqual({
        external: 'fw/a',
        copy: strict(['fw/a']),
        tag: '2.0.0',
      });
    });

    it('follows when it is loose', () => {
      const record = externals(copy('b', ['fw/a'], { requiredVersion: '^2.0.0' }));

      expect(fallbacksOf(record, a, accepts)).toEqual([]);
      expect(strictObjectorOf(record, a, accepts)).toBeUndefined();
    });

    // A warm init reads b's copies in the scope rows an earlier run stored: they already run b's own build.
    it('is no objector once its copies are scoped', () => {
      const record = externals(strict(['fw/a']));
      record[1]![1].versions[1]!.action = 'scope';

      expect(strictObjectorOf(record, a, accepts)).toBeUndefined();
    });

    // b also ships fw/x, which a lacks: it falls back for coverage, so its range objects to nothing.
    it('is no objector when its remote falls back for coverage', () => {
      const record = externals(strict(['fw/a', 'fw/x']));

      expect(fallbacksOf(record, a, accepts)).toEqual(['b']);
      expect(strictObjectorOf(record, a, accepts)).toBeUndefined();
    });
  });

  // Copies at one tag that ship the same specifiers cost the same, so host, root basis and name decide.
  it('ranks copies of one tag and surface by host, root basis, then name', () => {
    const row = (host: boolean, ...remotes: SharedVersionMeta[]) =>
      serving(['fw', external(version('share', remotes, '1.0.0', host))]);

    expect(row(true, copy('h', ['fw']), copy('a', ['fw']))).toEqual<ServingBuild>({
      remote: 'h',
      tag: '1.0.0',
    });
    expect(row(false, copy('c', ['fw']), copy('a', ['fw']))).toEqual<ServingBuild>({
      remote: 'c',
      tag: '1.0.0',
    });
    // The basis is pooling's, so it is no candidate: neither of the rest is the basis, and the name decides.
    expect(
      row(false, copy('p', ['fw'], { servedBy: 'x' }), copy('m', ['fw']), copy('k', ['fw']))
    ).toEqual<ServingBuild>({ remote: 'k', tag: '1.0.0' });
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

  // A host leading share rows at two tags is a candidate at each, and with no other consumer the two rank equal
  // down to the name. The pick keeps the first in record order, as the stable sort it replaced did.
  it('keeps the first of two equally ranked candidates of one remote', () => {
    const hostAt = (...tags: string[]) =>
      serving([
        'fw',
        external(...tags.map(tag => version('share', [copy('h', ['fw'])], tag, true))),
      ]);

    expect(hostAt('2.0.0', '1.0.0')).toEqual<ServingBuild>({ remote: 'h', tag: '2.0.0' });
    expect(hostAt('1.0.0', '2.0.0')).toEqual<ServingBuild>({ remote: 'h', tag: '1.0.0' });
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

describe('costTable', () => {
  // Every subset of the secondaries gives twice as many distinct surfaces at one tag as the scanned list holds,
  // so pricing runs the sorted-key path past it as well; sized from the cap so raising it keeps that coverage.
  // The second-to-last build repeats a surface tolled past the list, the last one on it. Strict consumers at an
  // older tag make the tolls differ by surface.
  it('prices every build as a fresh table would, past the scanned surfaces too', () => {
    const count = 2 * SCANNED_SURFACES_PER_TAG;
    const secondaries = Array.from(
      { length: Math.ceil(Math.log2(count)) },
      (_, bit) => `fw/${String.fromCharCode(97 + bit)}`
    );
    const subsets = Array.from({ length: count }, (_, i) =>
      secondaries.filter((_, bit) => i & (1 << bit))
    );
    const candidates = [...subsets, subsets[SCANNED_SURFACES_PER_TAG + 4]!, subsets[3]!].map(
      (ships, i) => copy(`r${String(i).padStart(2, '0')}`, ['fw', ...ships])
    );
    const strict = { strictVersion: true, requiredVersion: '~0.9.0' };
    const record: [ExternalName, SharedExternal][] = [
      [
        'fw',
        external(
          version('share', candidates, '1.0.0'),
          version(
            'skip',
            [copy('s1', ['fw', 'fw/a'], strict), copy('s2', ['fw/c'], strict)],
            '0.9.0'
          )
        ),
      ],
    ];
    const consumers = consumersOf(record);
    const builds = candidates.map(c => ({ remote: c.name, tag: '1.0.0' }));

    const shared = costTable(consumers, accepts);
    const priced = builds.map(build => shared(build));

    expect(priced).toEqual(builds.map(build => costTable(consumers, accepts)(build)));
    expect(new Set(priced.map(cost => JSON.stringify(cost))).size).toBeGreaterThan(1);
  });

  // Hosts are exempt from shipsTwoTags, so a host leading share rows at two tags publishes a surface that mixes
  // them. h1 and h2 ship fw and fw/a at 2.0.0 but swap which one comes from the 1.0.0 row; only h1 serves fw at
  // 2.0.0, which strict s1 rejects. Sharing a toll on specifiers alone would price h2 as h1.
  it('tolls surfaces with the same specifiers at different tags apart', () => {
    const strict = { strictVersion: true, requiredVersion: '^1.0.0' };
    const record: [ExternalName, SharedExternal][] = [
      [
        'fw',
        external(
          version('share', [copy('h1', ['fw'])], '2.0.0', true),
          version('share', [copy('h2', ['fw'])], '1.0.0', true),
          version('skip', [copy('s1', ['fw'], strict)], '1.0.1')
        ),
      ],
      [
        'fw/a',
        external(
          version('share', [copy('h2', ['fw/a'])], '2.0.0', true),
          version('share', [copy('h1', ['fw/a'])], '1.0.0', true)
        ),
      ],
    ];
    const consumers = consumersOf(record);
    const builds = ['h1', 'h2'].map(remote => ({ remote, tag: '2.0.0' }));

    const shared = costTable(consumers, accepts);
    const priced = builds.map(build => shared(build));

    expect(priced).toEqual(builds.map(build => costTable(consumers, accepts)(build)));
    expect(priced[0]).not.toEqual(priced[1]);
  });
});

describe('shareServingCopies', () => {
  const toServing: ServingBuild = { remote: 'serving', tag: '2.0.0' };
  const shape = (e: SharedExternal) =>
    e.versions.map(v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name)}]`);

  it("shares the serving build's skipped copy at the serving tag, in front of its row", () => {
    const testing = external(
      version('share', [copy('old', ['fw/testing'])], '1.0.0'),
      version(
        'skip',
        [copy('other', ['fw/testing']), copy('serving', ['fw/testing'])],
        '2.0.0',
        true
      )
    );

    shareServingCopies(testing, toServing);

    expect(shape(testing)).toEqual(['1.0.0:share:[old]', '2.0.0:share:[serving,other]']);
    // The host no longer leads the row.
    expect(testing.versions[1]!.host).toBe(false);
  });

  // A host that ships the package at two tags serves both.
  it("shares the serving build's skipped copy at another tag too, and the host keeps leading it", () => {
    const elsewhere = external(version('skip', [copy('serving', ['fw/testing'])], '1.0.0', true));

    shareServingCopies(elsewhere, toServing);

    expect(shape(elsewhere)).toEqual(['1.0.0:share:[serving]']);
    expect(elsewhere.versions[0]!.host).toBe(true);
  });

  it('leaves a skipped copy at a tag with a share row, and an external without the copy, alone', () => {
    const shared = external(
      version('share', [copy('other', ['fw/testing'])], '2.0.0'),
      version('skip', [copy('serving', ['fw/testing'])], '2.0.0')
    );
    const without = external(version('skip', [copy('other', ['fw/testing'])], '1.0.0'));
    const before = structuredClone([shared, without]);

    shareServingCopies(shared, toServing);
    shareServingCopies(without, toServing);

    expect([shared, without]).toEqual(before);
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

  // A host that ships the package at two tags serves both.
  it('leaves a share row the serving build leads at another tag untouched', () => {
    const own = external(version('share', [copy('serving', ['fw/testing'])], '1.0.0', true));
    const before = structuredClone(own);

    followServingBuild(own, toServing, accepts);

    expect(own).toEqual(before);
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

describe('strictTagScopes', () => {
  // A determine run after an override eviction re-elects a strict external and demotes a copy to a skip row.
  it('serves a tag from its share row when a skip row comes first', () => {
    const [tagScope] = strictTagScopes({
      core: external(
        version('skip', [copy('x', ['core'])]),
        version('share', [copy('a', ['core', 'core/sub']), copy('b', ['core'])])
      ),
    });

    expect(tagScope!['core']!.servingBuild).toBe('a');
    expect(tagScope!['core']!.versions.map(v => [v.action, v.remotes.map(r => r.name)])).toEqual([
      ['skip', ['x']],
      ['share', ['a', 'b']],
    ]);
  });

  it('elects no serving build for a tag without a share row', () => {
    const [tagScope] = strictTagScopes({
      core: external(version('skip', [copy('x', ['core'])])),
    });

    expect(tagScope!['core']!.servingBuild).toBeUndefined();
    expect(tagScope!['core']!.versions).toEqual([version('skip', [copy('x', ['core'])])]);
  });
});
