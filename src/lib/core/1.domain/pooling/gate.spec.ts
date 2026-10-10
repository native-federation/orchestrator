import type { SharedExternal, SharedVersion, SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { copiesByRemote } from './builds';
import { committedView, coverFromMap } from './gate';
import type { PoolMember } from './membership';

/**
 * The projections the runtime path reads off a committed record. Nothing here decides anything, so each test
 * is about what the stored record *says*: what each build serves, and what the committed map publishes.
 */

// A remote's copy of one member: `req` is its own range, `entries` the specifiers it carries (defaulting to
// just the member itself, which is what a flat build emits).
type Copy = {
  remote: string;
  req?: string;
  entries?: Record<string, string>;
  host?: boolean;
  servedBy?: string;
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
const viewOf = (members: PoolMember[], without?: string) =>
  committedView(
    members,
    copiesByRemote(members),
    members.map(m => m.name),
    without
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

    // A flat build ships `@ng/core/testing` as a package of its own, a dense one as an entry of `@ng/core`, and
    // both share it. `generate-import-map` hands it to the package stored first, whatever the pool's name order.
    it('names the package stored first for a specifier two shared packages claim', () => {
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

      expect(
        committedView(
          members,
          copiesByRemote(members),
          ['@ng/core/testing', '@ng/core'],
          'loaded'
        ).global.get('@ng/core/testing')
      ).toMatchObject({
        remote: 'flat',
      });
    });
  });
});

describe('coverFromMap', () => {
  const policy = { shareScope: '__GLOBAL__', selfFill: false, scopeUrlOf: () => undefined };

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
});
