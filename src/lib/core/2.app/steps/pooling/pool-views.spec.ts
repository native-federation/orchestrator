import type { SharedExternal, SharedVersion, SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import {
  consumedMembers,
  consumedSpecifiers,
  hostRemotes,
  liveBuilds,
  ownCopies,
  servingBuilds,
  sharedTagPerSpecifier,
} from './pool-views';
import type { PoolMember } from './pool.types';

/**
 * The projections every gate reads. Nothing here decides anything, so each test is about what the stored
 * record *says* — in particular which copies a build may offer others (`scope` copies may not) and which it
 * runs itself (`scope` copies are exactly what it runs).
 */

// A remote's copy of one member: `req` is its own range, `entries` the specifiers it carries (defaulting to
// just the member itself, which is what a flat build emits).
type Copy = { remote: string; req?: string; entries?: Record<string, string>; host?: boolean };

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

const instances = (members: PoolMember[], islanded?: Set<string>) =>
  Object.fromEntries(
    [...liveBuilds(members, islanded)].map(([remote, build]) => [
      remote,
      Object.fromEntries(build.instance),
    ])
  );

describe('liveBuilds', () => {
  describe('the instance a build runs', () => {
    it('maps every remote to the members it ships and the tag it ships them at', () => {
      expect(instances(splitPair())).toEqual({
        'mfe-a': { '@angular/core': '22.1.0', '@angular/router': '22.1.0' },
        'mfe-b': { '@angular/core': '22.0.5' },
      });
    });

    it('never counts a `scope` version: determine refused it, pooling does not promote it', () => {
      expect(instances(soleProviderIsland())['form-overview']).toEqual({
        '@angular/animations': '21.2.18',
      });
    });

    it('drops an islanded remote entirely, including members it solely provides', () => {
      // The capture's failure: without this, animations@21.2.18 stays shared beside core@22.0.8.
      expect(liveBuilds(soleProviderIsland(), new Set(['form-overview'])).has('form-overview')).toBe(
        false
      );
      expect(instances(soleProviderIsland(), new Set(['form-overview']))).toEqual({
        approve: { '@angular/core': '22.0.8' },
        mutations: { '@angular/core': '22.0.8' },
      });
    });
  });

  describe('coverage, keyed by specifier', () => {
    // The lever worth the most on the eleven-remote capture. A flat remote declares `@ng/core/testing` as
    // its own external; a dense one carries the same specifier as an entry of `@ng/core`. In external-name
    // space those two build shapes are {core, core/testing} against {core}, so neither covers the other and
    // both self-serve — for a build-tool reason with no provenance content whatsoever. In specifier space
    // they serve the identical set and either can anchor the other.
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
      const builds = liveBuilds(members);

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

    it('excludes a scoped copy, which is about to self-serve', () => {
      const members = [
        member('@ng/core', [
          { tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe1' }] },
          { tag: '21.0.0', action: 'scope', copies: [{ remote: 'legacy' }] },
        ]),
      ];

      expect(liveBuilds(members).has('legacy')).toBe(false);
      // Still consumed, though — it has to be able to import what it declares.
      expect([...consumedSpecifiers(members).get('legacy')!]).toEqual(['@ng/core']);
    });
  });

  describe('the tag each specifier is served at', () => {
    it('reads no tag from a scoped or islanded copy, mirroring coverage', () => {
      const members = [
        member('@ng/core', [
          { tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe1' }, { remote: 'mfe2' }] },
          { tag: '21.0.0', action: 'scope', copies: [{ remote: 'legacy' }] },
        ]),
      ];

      expect(liveBuilds(members).has('legacy')).toBe(false);
      expect(liveBuilds(members, new Set(['mfe2'])).has('mfe2')).toBe(false);
      expect(liveBuilds(members, new Set(['mfe2'])).get('mfe1')!.tags.get('@ng/core')).toBe(
        '22.0.5'
      );
    });
  });
});

describe('ownCopies', () => {
  // The counterpart of `liveBuilds`: what a remote runs itself, `scope` copies included. Only this question
  // can see a torn family, which is why `findTornRemotes` reads it rather than the instance. It carries the
  // entries too, since the tear it looks for is a specifier resolving at a tag its package does not.
  it('reads a scoped copy, which the instance omits', () => {
    const own = ownCopies(soleProviderIsland());

    expect(own.get('form-overview')!.map(c => `${c.member}@${c.tag}`)).toEqual([
      '@angular/core@21.2.18',
      '@angular/animations@21.2.18',
    ]);
  });

  it('carries the specifiers each copy declares', () => {
    const own = ownCopies(soleProviderIsland());

    expect(Object.keys(own.get('form-overview')![0]!.entries)).toEqual(['@angular/core']);
  });

  it('reads only the remotes it was asked for', () => {
    expect([...ownCopies(soleProviderIsland(), new Set(['approve'])).keys()]).toEqual(['approve']);
  });
});

describe('consumedMembers', () => {
  it('lists what a remote must be served', () => {
    expect(Object.fromEntries(consumedMembers(splitPair()))).toEqual({
      'mfe-a': ['@angular/core', '@angular/router'],
      'mfe-b': ['@angular/core'],
    });
  });

  it('includes members whose copy was scoped, which the instance excludes', () => {
    expect(consumedMembers(soleProviderIsland()).get('form-overview')).toEqual([
      '@angular/core',
      '@angular/animations',
    ]);
  });
});

describe('servingBuilds', () => {
  const none = new Set<string>();

  it('names the build behind each shared member', () => {
    expect(Object.fromEntries(servingBuilds(splitPair(), none))).toEqual({
      '@angular/core': 'mfe-b',
      '@angular/router': 'mfe-a',
    });
  });

  it('leaves a member unserved once islanding took every copy that could serve it', () => {
    const serving = servingBuilds(splitPair(), new Set(['mfe-a']));

    expect(serving.get('@angular/core')).toBe('mfe-b');
    expect(serving.has('@angular/router')).toBe(false);
  });
});

describe('sharedTagPerSpecifier', () => {
  it('reads the shared tag from a basis that islanding has not taken', () => {
    const members = [
      member('@ng/core', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'gone' }, { remote: 'mfe2' }] },
      ]),
    ];

    expect(sharedTagPerSpecifier(members, new Set(['gone'])).get('@ng/core')).toBe('22.0.5');
    // Nobody left to serve it: the member has no shared tag to witness against.
    expect(sharedTagPerSpecifier(members, new Set(['gone', 'mfe2'])).size).toBe(0);
  });

  // Reading the winning version's basis alone understates the mapping, which islands remotes that were
  // never at risk: a package's secondary entrypoints are routinely published from a `skip` copy.
  it('includes a specifier only a skipping copy publishes', () => {
    const members = [
      member('@ng/core', [
        { tag: '22.0.8', action: 'share', copies: [{ remote: 'mfe5' }] },
        { tag: '22.0.8', copies: [{ remote: 'mfe2', entries: { '@ng/core/testing': 't.js' } }] },
      ]),
    ];

    expect(Object.fromEntries(sharedTagPerSpecifier(members, new Set()))).toEqual({
      '@ng/core': '22.0.8',
      '@ng/core/testing': '22.0.8',
    });
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
