import type { SharedExternal, SharedVersion, SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { committedView, consumedMembers, hostRemotes } from './pool-views';
import type { PoolMember } from './pool.types';

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
      const { builds } = committedView(members);

      expect([...builds.get('dense')!.coverage.keys()].sort()).toEqual([
        '@ng/core',
        '@ng/core/testing',
      ]);
      expect([...builds.get('flat')!.coverage.keys()].sort()).toEqual([
        '@ng/core',
        '@ng/core/testing',
      ]);
      expect(builds.get('dense')!.coverage.get('@ng/core/testing')).toBe('t.js');
    });

    // Committed, a scoped copy is a stable island: its files are in the map under its own scope and it
    // demonstrably runs its own build, so a remote loaded later may take them.
    it('includes a scoped copy, with the tag it runs', () => {
      const { builds } = committedView(soleProviderIsland());

      expect(Object.fromEntries(builds.get('form-overview')!.instance)).toEqual({
        '@angular/core': '21.2.18',
        '@angular/animations': '21.2.18',
      });
      expect(builds.get('form-overview')!.tags.get('@angular/core')).toBe('21.2.18');
    });
  });

  describe('the global map', () => {
    it('names the build behind each shared specifier', () => {
      const { global } = committedView(splitPair());

      expect(global.get('@angular/core')).toMatchObject({ tag: '22.0.5', remote: 'mfe-b' });
      expect(global.get('@angular/router')).toMatchObject({ tag: '22.1.0', remote: 'mfe-a' });
    });

    // A package's secondary entrypoints are routinely published from a `skip` copy of the shared tag.
    it('includes a specifier only a skipping copy publishes', () => {
      const members = [
        member('@ng/core', [
          { tag: '22.0.8', action: 'share', copies: [{ remote: 'mfe5' }] },
          { tag: '22.0.8', copies: [{ remote: 'mfe2', entries: { '@ng/core/testing': 't.js' } }] },
        ]),
      ];

      expect(committedView(members).global.get('@ng/core/testing')).toMatchObject({
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

      expect([...committedView(members).global.keys()]).toEqual(['@ng/core']);
    });
  });
});

describe('consumedMembers', () => {
  it('lists what a remote must be served', () => {
    expect(Object.fromEntries(consumedMembers(splitPair()))).toEqual({
      'mfe-a': ['@angular/core', '@angular/router'],
      'mfe-b': ['@angular/core'],
    });
  });

  it('includes members whose copy was scoped', () => {
    expect(consumedMembers(soleProviderIsland()).get('form-overview')).toEqual([
      '@angular/core',
      '@angular/animations',
    ]);
  });
});

describe('hostRemotes', () => {
  // Only the *version* carries a host flag, never the individual copy, so the host is identified as
  // `remotes[0]` of a host-contributed version — which is sound because basis precedence sorts the host's
  // own copy first on insert (see docs/version-resolver.md §"The basis of a version"). Fixtures have to
  // honour that ordering or they encode a record the cache cannot produce.
  it('is read off the version it contributed, as its basis', () => {
    const members = [
      member('@ng/core', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'host', host: true }, { remote: 'mfe2' }],
        },
      ]),
    ];
    expect(hostRemotes(members)).toEqual(new Set(['host']));
  });

  it('is nobody when no version came from a host', () => {
    expect(hostRemotes(splitPair())).toEqual(new Set());
  });
});
