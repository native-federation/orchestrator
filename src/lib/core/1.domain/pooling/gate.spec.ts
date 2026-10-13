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
    copiesByRemote(members, () => false),
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

    // A package's secondary entrypoints are routinely published from a `skip` copy of the shared tag.
    it('includes a specifier only a skipping copy publishes', () => {
      const members = [
        member('@ng/core', [
          { tag: '22.0.8', action: 'share', copies: [{ remote: 'mfe5' }] },
          { tag: '22.0.8', copies: [{ remote: 'mfe2', entries: { '@ng/core/testing': 't.js' } }] },
        ]),
      ];

      expect(viewOf(members).global.get('@ng/core/testing')).toMatchObject({
        tag: '22.0.8',
        remote: 'mfe2',
      });
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

    // A named scope has no `imports` to inherit: the load's own scope gets an override, which may name any copy,
    // as update-cache's `provided` does there.
    it('counts that copy in a named scope', () => {
      expect([...viewOf(runtimeJoiners(), undefined, 'team').global]).toEqual([
        ['@ng/core', { tag: '22.0.8', remote: 'mfe5', file: '@ng/core.js' }],
        ['@ng/core/new', { tag: '22.0.8', remote: 'joiner', file: 'n.js' }],
        ['@ng/core/late', { tag: '22.0.8', remote: 'late', file: 'l.js' }],
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
          committedView(members, copiesByRemote(members, () => false), recordOrder, {
            shareScope: GLOBAL_SCOPE,
            without: 'loaded',
          }).global.get('@ng/core/testing')
        ).toEqual({ tag: '22.0.8', remote: 'dense', file: 't.js' });
      });
  });
});

describe('coverFromMap', () => {
  const policy = {
    shareScope: '__GLOBAL__',
    selfFill: false,
    scopeUrlOf: () => undefined,
    isChunked: () => false,
  };

  // Defensive: unreachable under a coherent committed map, where a remote that agrees with the map never has
  // a resolver-scoped member (jsdev-b-5's probe). A scope the map serves only in part, or not at all, stays a
  // scope: half its entrypoints on the map's files and half on its own build would tear it.
  it('leaves a resolver scope the map serves only in part, or not at all, out of the covers', () => {
    const scoped = (entries: Record<string, string>) => [
      member('@ng/core', [
        { tag: '22.0.0', action: 'share', copies: [{ remote: 'F' }] },
        { tag: '22.1.0', action: 'scope', copies: [{ remote: 'mfe', entries }] },
      ]),
    ];

    const cases: Record<string, string>[] = [
      { '@ng/core': 'core.js', '@ng/core/testing': 'testing.js' },
      { '@ng/core/testing': 'testing.js' },
    ];
    for (const entries of cases) {
      const members = scoped(entries);
      const view = viewOf(members, 'mfe');
      expect(
        coverFromMap('mfe', members, view, { '@ng/core': { action: 'scope' } }, policy)
      ).toEqual({ covers: [] });
    }
  });

  // mfe's copy of `@ng/core` ships rxjs-interop, which the map lacks; the map serves its root from F. With
  // the coverage policies off, mfe would self-fill rxjs-interop from its own build. A flat file binds its
  // imports through the map, so that is a cover. A chunked one imports mfe's own core internals beside F's
  // core: the package is torn, and no member is covered.
  it("reports a package torn when a chunked copy's own entrypoint would run beside the map's files", () => {
    const withMfe = (entries?: Record<string, string>) => [
      member('@ng/core', [
        {
          tag: '22.0.0',
          action: 'share',
          copies: [{ remote: 'F' }, { remote: 'mfe', cached: false, entries }],
        },
      ]),
    ];
    const actions = { '@ng/core': { action: 'skip' as const, covered: ['@ng/core'] } };
    const selfFill = { ...policy, selfFill: true };
    const cover = (members: PoolMember[], isChunked: (remote: string) => boolean) =>
      coverFromMap('mfe', members, viewOf(members, 'mfe'), actions, { ...selfFill, isChunked });
    const rootCovered = {
      covers: [{ name: '@ng/core', toSkip: false, covered: ['@ng/core'], override: {} }],
    };

    const interop = withMfe({ '@ng/core': 'c.js', '@ng/core/rxjs-interop': 'r.js' });
    expect(cover(interop, () => false)).toEqual(rootCovered);
    expect(cover(interop, r => r === 'mfe')).toEqual({ torn: '@ng/core' });
    // Only an entrypoint mfe runs from its own build counts: F's chunked files are the map's, and a copy the
    // map serves whole runs on them alone.
    expect(cover(withMfe(), () => true)).toEqual(rootCovered);
  });

  // mfe's flat core inherits the map's file whole (a skip with nothing to cover); its rxjs-interop, a package
  // of its own the map lacks, it serves itself. From a chunked build that file binds mfe's core internals
  // beside F's core, though the two are separate externals.
  it('counts a package a copy inherits from the map whole as mapped', () => {
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
      '@ng/core': { action: 'skip' as const },
      '@ng/core/rxjs-interop': { action: 'share' as const },
    };
    const cover = (isChunked: (remote: string) => boolean) =>
      coverFromMap('mfe', members, viewOf(members, 'mfe'), actions, {
        ...policy,
        selfFill: true,
        isChunked,
      });

    expect(cover(() => false)).toEqual({ covers: [] });
    expect(cover(r => r === 'mfe')).toEqual({ torn: '@ng/core' });
  });
});
