import {
  GLOBAL_SCOPE,
  type SharedExternal,
  type SharedVersion,
  type SharedVersionAction,
} from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { copiesByRemote } from './builds';
import { committedView, coverFromMap } from './gate';
import type { PoolMember } from './membership';

/**
 * The projections the runtime path reads off a committed record. Nothing here decides anything, so each test
 * is about what the stored record *says*: what each build serves, and what the committed map publishes.
 */

// A remote's copy of one member: `req` is its own range, `entries` the specifiers it carries (defaulting to
// just the member itself, which is what a flat build emits). A copy is `cached` unless it says otherwise, as
// generate-import-map marks every copy the committed map publishes; the global map counts only those.
type Copy = {
  remote: string;
  req?: string;
  entries?: Record<string, string>;
  host?: boolean;
  servedBy?: string;
  cached?: boolean;
};

const member = (
  name: string,
  versions: { tag: string; action?: SharedVersionAction; copies: Copy[] }[]
): PoolMember => ({
  name,
  external: {
    dirty: false,
    versions: versions.map<SharedVersion>(v => ({
      tag: v.tag,
      host: v.copies.some(c => c.host),
      action: v.action ?? 'skip',
      remotes: v.copies.map(c =>
        mockVersionRemote(c.remote, name, {
          requiredVersion: c.req ?? '^22.0.0',
          entries: c.entries ?? { [name]: `${name}.js` },
          servedBy: c.servedBy,
          cached: c.cached ?? true,
        })
      ),
    })),
  } satisfies SharedExternal,
});

// The strict-pin split: mfe-b pins core to ~22.0.5, so determine shares core from mfe-b's build while
// router — which only mfe-a provides — stays on mfe-a's 22.1.0.
const splitPair = (): PoolMember[] => [
  member('@angular/core', [
    { tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe-b', req: '~22.0.5' }] },
    { tag: '22.1.0', copies: [{ remote: 'mfe-a' }] },
  ]),
  member('@angular/router', [{ tag: '22.1.0', action: 'share', copies: [{ remote: 'mfe-a' }] }]),
];

// The production capture's shape, reduced: the Angular-21 remote is islanded on core (determine marked it
// `scope`) but is the SOLE provider of animations, which it still shares at 21.2.18.
const soleProviderIsland = (): PoolMember[] => [
  member('@angular/core', [
    { tag: '22.0.8', action: 'share', copies: [{ remote: 'approve' }, { remote: 'mutations' }] },
    { tag: '21.2.18', action: 'scope', copies: [{ remote: 'form-overview', req: '^21.0.0' }] },
  ]),
  member('@angular/animations', [
    { tag: '21.2.18', action: 'share', copies: [{ remote: 'form-overview', req: '^21.0.0' }] },
  ]),
];

// The fixtures list members in the order they are stored; `without` is the remote being loaded.
const viewOf = (members: PoolMember[], without?: string, shareScope = GLOBAL_SCOPE) =>
  committedView(
    members,
    copiesByRemote(members),
    members.map(m => m.name),
    {
      shareScope,
      without,
    }
  );

describe('committedView', () => {
  describe('builds, keyed by specifier', () => {
    // A flat remote declares `@ng/core/testing` as its own external; a dense one carries the same specifier
    // as an entry of `@ng/core`. In external-name space the two shapes never cover each other, for a
    // build-tool reason with no provenance content. In specifier space they serve the identical set.
    it('gathers every specifier a build serves, across members, with the file it serves it from', () => {
      const members = [
        member('@ng/core', [
          {
            tag: '22.0.5',
            action: 'share',
            copies: [
              { remote: 'dense', entries: { '@ng/core': 'core.js', '@ng/core/testing': 't.js' } },
              { remote: 'flat' },
            ],
          },
        ]),
        member('@ng/core/testing', [{ tag: '22.0.5', copies: [{ remote: 'flat' }] }]),
      ];
      const { builds } = viewOf(members);

      expect([...builds.get('dense')!.tags.keys()].sort()).toEqual([
        '@ng/core',
        '@ng/core/testing',
      ]);
      expect([...builds.get('flat')!.tags.keys()].sort()).toEqual(['@ng/core', '@ng/core/testing']);
    });

    // Committed, a scoped copy is a stable island: its files are in the map under its own scope and it
    // demonstrably runs its own build, so a remote loaded later may take them.
    it('includes a scoped copy, with the tag it runs', () => {
      const { builds } = viewOf(soleProviderIsland());

      expect(Object.fromEntries(builds.get('form-overview')!.tagByMember)).toEqual({
        '@angular/core': '21.2.18',
        '@angular/animations': '21.2.18',
      });
      expect(builds.get('form-overview')!.tags.get('@angular/core')).toBe('21.2.18');
    });
  });

  describe('the global map', () => {
    it('names the build behind each shared specifier', () => {
      const { global } = viewOf(splitPair());

      expect(global.get('@angular/core')).toMatchObject({ tag: '22.0.5', remote: 'mfe-b' });
      expect(global.get('@angular/router')).toMatchObject({ tag: '22.1.0', remote: 'mfe-a' });
    });

    // update-cache stored the loaded remote's copies, which the committed map does not hold: a share row it
    // opened at a newer tag must not hide the committed one, and its build is no committed build.
    it('leaves out the remote being loaded', () => {
      const members = [
        member('@ng/core', [
          { tag: '22.1.0', action: 'share', copies: [{ remote: 'loaded' }] },
          { tag: '22.0.8', action: 'share', copies: [{ remote: 'mfe5' }] },
          {
            tag: '22.0.8',
            copies: [{ remote: 'loaded', entries: { '@ng/core/testing': 't.js' } }],
          },
        ]),
      ];
      const { global, builds } = viewOf(members, 'loaded');

      expect([...global]).toEqual([
        ['@ng/core', { tag: '22.0.8', remote: 'mfe5', file: '@ng/core.js' }],
      ]);
      expect([...builds.keys()]).toEqual(['mfe5']);
    });

    // Only share rows publish: a `skip` copy's entrypoint the shared version lacks is not in `imports`.
    it('leaves out a specifier only a skipping copy ships', () => {
      const members = [
        member('@ng/core', [
          { tag: '22.0.8', action: 'share', copies: [{ remote: 'mfe5' }] },
          { tag: '22.0.8', copies: [{ remote: 'mfe2', entries: { '@ng/core/testing': 't.js' } }] },
        ]),
      ];

      expect(viewOf(members).global.has('@ng/core/testing')).toBe(false);
    });

    // The map names a subpool copy's specifiers from its subpool's build, in its own scope, so counting it as
    // a global publisher would describe a mapping that does not exist.
    it('leaves out a copy served by another build', () => {
      const members = [
        member('@ng/core', [
          {
            tag: '22.0.8',
            action: 'share',
            copies: [
              { remote: 'mfe5' },
              {
                remote: 'mfe2',
                servedBy: 'mfe9',
                entries: { '@ng/core': 'c.js', '@ng/core/testing': 't.js' },
              },
            ],
          },
        ]),
      ];

      expect([...viewOf(members).global.keys()]).toEqual(['@ng/core']);
    });

    // `joiner` was loaded at runtime into the share row at its tag, and `late` into the skip row: each served its
    // extra entrypoint into its own scope alone, so neither is `cached` and `imports` holds neither entrypoint.
    // A later load inheriting `imports` would be told the map serves what it does not.
    const runtimeJoiners = () => [
      member('@ng/core', [
        {
          tag: '22.0.8',
          action: 'share',
          copies: [
            { remote: 'mfe5' },
            {
              remote: 'joiner',
              cached: false,
              entries: { '@ng/core': 'c.js', '@ng/core/new': 'n.js' },
            },
          ],
        },
        {
          tag: '22.0.8',
          copies: [{ remote: 'late', cached: false, entries: { '@ng/core/late': 'l.js' } }],
        },
      ]),
    ];

    it('leaves out a copy the committed map does not publish', () => {
      expect([...viewOf(runtimeJoiners()).global.keys()]).toEqual(['@ng/core']);
    });

    // A named scope has no `imports` to inherit: the load's own scope gets an override, which may name any copy of
    // the shared version, as update-cache's `provided` does there.
    it('counts that copy in a named scope', () => {
      expect([...viewOf(runtimeJoiners(), undefined, 'team').global]).toEqual([
        ['@ng/core', { tag: '22.0.8', remote: 'mfe5', file: '@ng/core.js' }],
        ['@ng/core/new', { tag: '22.0.8', remote: 'joiner', file: 'n.js' }],
      ]);
    });

    // A flat build ships `@ng/core/testing` as an external of its own, a dense one as an entry of `@ng/core`, and
    // both share it. The package's stored serving build claims it, whichever external is stored first.
    for (const recordOrder of [
      ['@ng/core/testing', '@ng/core'],
      ['@ng/core', '@ng/core/testing'],
    ])
      it(`names the serving build for a specifier two externals of one package claim (${recordOrder[0]} first)`, () => {
        const members = [
          member('@ng/core', [
            {
              tag: '22.0.8',
              action: 'share',
              copies: [
                { remote: 'dense', entries: { '@ng/core': 'c.js', '@ng/core/testing': 't.js' } },
              ],
            },
          ]),
          member('@ng/core/testing', [
            { tag: '22.0.8', action: 'share', copies: [{ remote: 'flat' }] },
          ]),
        ];
        for (const { external } of members) external.servingBuild = 'dense';

        expect(
          committedView(members, copiesByRemote(members), recordOrder, {
            shareScope: GLOBAL_SCOPE,
            without: 'loaded',
          }).global.get('@ng/core/testing')
        ).toEqual({ tag: '22.0.8', remote: 'dense', file: 't.js' });
      });
  });

  // A subpool member's copy keeps its own tag in the record, but the map points its scope at the subpool
  // build's files, so that is what it runs: the build's file at the tag the build pins.
  describe('what a build runs off the map', () => {
    // `sub` ships core at 22.0.9 but is served by `x`, which committed core at 22.0.8.
    const subpool = (subEntries: Record<string, string> = { '@ng/core': 'sub-core.js' }) => [
      member('@ng/core', [
        {
          tag: '22.0.9',
          copies: [{ remote: 'sub', servedBy: 'x', entries: subEntries }],
        },
        {
          tag: '22.0.8',
          action: 'share',
          copies: [{ remote: 'x', entries: { '@ng/core': 'x-core.js' } }],
        },
      ]),
    ];

    it("runs a served copy's specifier from its build's file, at the build's tag", () => {
      expect(viewOf(subpool()).runsOffMap.get('sub')?.get('@ng/core')).toEqual({
        tag: '22.0.8',
        remote: 'x',
        file: 'x-core.js',
      });
    });

    // A corrupt record: `x` lists core in two rows with different files. The first row wins, as in
    // `copiesByRemote`, so the file and the tag come from one row.
    it("takes the build's file from its first row", () => {
      const members = subpool();
      members[0]!.external.versions.push({
        tag: '22.0.7',
        host: false,
        action: 'skip',
        remotes: [
          mockVersionRemote('x', '@ng/core', {
            requiredVersion: '^22.0.0',
            entries: { '@ng/core': 'x-core-old.js' },
          }),
        ],
      });

      expect(viewOf(members).runsOffMap.get('sub')?.get('@ng/core')).toMatchObject({
        remote: 'x',
        file: 'x-core.js',
      });
    });

    // Flat vs dense: `x` ships core/testing as a package of its own, so its file is in a later member's row.
    it("takes a specifier the build ships in a later row from that row's file", () => {
      const members = [
        ...subpool({ '@ng/core': 'sub-core.js', '@ng/core/testing': 'sub-t.js' }),
        member('@ng/core/testing', [
          {
            tag: '22.0.8',
            action: 'share',
            copies: [{ remote: 'x', entries: { '@ng/core/testing': 'x-t.js' } }],
          },
        ]),
      ];

      expect(viewOf(members).runsOffMap.get('sub')?.get('@ng/core/testing')).toEqual({
        tag: '22.0.8',
        remote: 'x',
        file: 'x-t.js',
      });
    });

    // Specifiers are package names from the remote entry, so one may well name an Object.prototype member.
    it('resolves a specifier named like an object property to the build file', () => {
      const tricky = { constructor: 'ctor.js', ['__proto__']: 'proto.js' };
      const members = [
        member('@ng/core', [
          { tag: '22.0.9', copies: [{ remote: 'sub', servedBy: 'x', entries: tricky }] },
          {
            tag: '22.0.8',
            action: 'share',
            copies: [
              { remote: 'x', entries: { constructor: 'x-ctor.js', ['__proto__']: 'x-proto.js' } },
            ],
          },
        ]),
      ];
      const runs = viewOf(members).runsOffMap.get('sub');

      expect(runs?.get('constructor')).toMatchObject({ remote: 'x', file: 'x-ctor.js' });
      expect(runs?.get('__proto__')).toMatchObject({ remote: 'x', file: 'x-proto.js' });
    });

    it('falls back on a specifier named like an object property the build lacks', () => {
      const runs = viewOf(
        subpool({ '@ng/core': 'sub-core.js', constructor: 'ctor.js', ['__proto__']: 'proto.js' })
      ).runsOffMap.get('sub');

      expect(runs?.get('constructor')).toMatchObject({ remote: 'sub', file: 'ctor.js' });
      expect(runs?.get('__proto__')).toMatchObject({ remote: 'sub', file: 'proto.js' });
    });

    // The tag is still the build's: it pins the specifier's package, so its other entrypoints run at that tag.
    it("falls back to the copy's own file where the build has none", () => {
      const runs = viewOf(
        subpool({ '@ng/core': 'sub-core.js', '@ng/core/extra': 'sub-extra.js' })
      ).runsOffMap.get('sub');

      expect(runs?.get('@ng/core/extra')).toEqual({
        tag: '22.0.8',
        remote: 'sub',
        file: 'sub-extra.js',
      });
    });

    // Without a subpool every copy runs its own files: a skip copy only the entrypoints the map lacks, a
    // share copy nothing off the map.
    it('runs every copy from its own files when no copy is served by another build', () => {
      const members = [
        member('@ng/core', [
          {
            tag: '22.0.8',
            action: 'share',
            copies: [{ remote: 'mfe5', entries: { '@ng/core': 'c.js' } }],
          },
          {
            tag: '22.0.7',
            copies: [{ remote: 'mfe2', entries: { '@ng/core': 'c2.js', '@ng/core/t': 't2.js' } }],
          },
          { tag: '21.2.0', action: 'scope', copies: [{ remote: 'old', req: '^21.0.0' }] },
        ]),
      ];
      const { runsOffMap } = viewOf(members);

      expect([...runsOffMap].map(([remote, runs]) => [remote, [...runs]])).toEqual([
        ['mfe2', [['@ng/core/t', { tag: '22.0.7', remote: 'mfe2', file: 't2.js' }]]],
        ['old', [['@ng/core', { tag: '21.2.0', remote: 'old', file: '@ng/core.js' }]]],
      ]);
    });
  });
});

describe('coverFromMap', () => {
  const policy = {
    shareScope: '__GLOBAL__',
    scopeUrlOf: () => undefined,
  };

  // Defensive: unreachable under a coherent committed map, where a remote that agrees with the map never has
  // a resolver-scoped member. A scope whose package the map serves only in part reports the gap, as any copy
  // that does not skip does: half the package on the map's files and half on its own build would tear it.
  it('reports the gap of a resolver scope whose package the map serves only in part', () => {
    const scoped = (entries: Record<string, string>) => [
      member('@ng/core', [
        { tag: '22.0.0', action: 'share', copies: [{ remote: 'F' }] },
        { tag: '22.1.0', action: 'scope', copies: [{ remote: 'mfe', entries }] },
      ]),
    ];
    const cover = (entries: Record<string, string>) => {
      const members = scoped(entries);
      return coverFromMap(
        'mfe',
        members,
        viewOf(members, 'mfe'),
        { '@ng/core': { action: 'scope' } },
        policy
      );
    };

    expect(cover({ '@ng/core': 'core.js', '@ng/core/testing': 'testing.js' })).toEqual({
      gap: '@ng/core/testing',
    });
    expect(cover({ '@ng/core/testing': 'testing.js' })).toEqual({ gap: '@ng/core/testing' });
  });

  // mfe's copy of `@ng/core` joined F's share row with rxjs-interop, which the map lacks; the map serves its
  // root from F. A cover is whole or nothing, so the gap fails covering. Only a copy the map serves whole
  // takes F's files.
  it('reports the gap of a share the map serves only in part', () => {
    const withMfe = (entries?: Record<string, string>) => [
      member('@ng/core', [
        {
          tag: '22.0.0',
          action: 'share',
          copies: [{ remote: 'F' }, { remote: 'mfe', cached: false, entries }],
        },
      ]),
    ];
    const actions = { '@ng/core': { action: 'share' as const } };
    const cover = (members: PoolMember[]) =>
      coverFromMap('mfe', members, viewOf(members, 'mfe'), actions, policy);

    const interop = withMfe({ '@ng/core': 'c.js', '@ng/core/rxjs-interop': 'r.js' });
    expect(cover(interop)).toEqual({ gap: '@ng/core/rxjs-interop' });
    expect(cover(withMfe())).toEqual({
      covers: [{ name: '@ng/core', toSkip: true, override: {} }],
    });
  });

  // mfe's flat core is a skip the map covers whole; its rxjs-interop, an external of its own the map lacks,
  // would open beside F's core: the package is served in part, so the gap fails covering, though the two are
  // separate externals.
  it('counts a package a skip takes from the map whole as mapped', () => {
    const members = [
      member('@ng/core', [
        {
          tag: '22.0.0',
          action: 'share',
          copies: [{ remote: 'F' }, { remote: 'mfe', cached: false }],
        },
      ]),
      member('@ng/core/rxjs-interop', [
        { tag: '22.0.0', action: 'share', copies: [{ remote: 'mfe', cached: false }] },
      ]),
    ];
    const actions = {
      '@ng/core': { action: 'skip' as const, covered: ['@ng/core'] },
      '@ng/core/rxjs-interop': { action: 'share' as const },
    };
    expect(coverFromMap('mfe', members, viewOf(members, 'mfe'), actions, policy)).toEqual({
      gap: '@ng/core/rxjs-interop',
    });
  });

  // The host ships only core's testing entrypoint; mfe ships the root, which the map lacks, beside a pool-mate
  // the map serves whole. Opening or scoping the root alone would run core on two builds, so the gap fails
  // covering either way.
  it('reports the gap of a copy whose package the map serves only in part', () => {
    const members = [
      member('@ng/core', [
        {
          tag: '22.0.0',
          action: 'share',
          copies: [{ remote: 'F', entries: { '@ng/core/testing': 't.js' } }],
        },
        { tag: '22.1.0', action: 'scope', copies: [{ remote: 'mfe', cached: false }] },
      ]),
      member('@ng/common', [
        {
          tag: '22.0.0',
          action: 'share',
          copies: [{ remote: 'F' }, { remote: 'mfe', cached: false }],
        },
      ]),
    ];
    const cover = (action: 'share' | 'scope') =>
      coverFromMap(
        'mfe',
        members,
        viewOf(members, 'mfe'),
        {
          '@ng/core': { action },
          '@ng/common': { action: 'skip', covered: ['@ng/common'] },
        },
        policy
      );

    expect(cover('share')).toEqual({ gap: '@ng/core' });
    expect(cover('scope')).toEqual({ gap: '@ng/core' });
  });
});
