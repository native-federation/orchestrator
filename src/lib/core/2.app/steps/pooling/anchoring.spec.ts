import type { SharedExternal, SharedVersion, SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { acceptanceTable, acceptsAll, assignAnchors, covers, isWitnessed } from './anchoring';
import {
  arrivalOrder,
  consumedMembers,
  consumedSpecifiers,
  hostRemotes,
  liveBuilds,
  sharedTagPerSpecifier,
} from './pool-views';
import type { PoolMember } from './pool.types';

/**
 * The gates behind the provenance promise, tested on the portfolios that reproduce the defect it fixes —
 * `e2e/pooling/provenance.e2e.spec.ts` runs the same shapes in a browser.
 *
 * Two shapes recur and are worth naming up front:
 *  - *disjoint providers*: mfe1 solely provides core, mfe2 solely provides router, mfe3 consumes both.
 *    No build in the portfolio ships the pair mfe3 ends up running.
 *  - *the lockstep pair*: two providers overlap and agree exactly on what they share, yet the coupled pair
 *    is in neither build. No tag comparison can reach it, which is why coverage is the test.
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

// mfe1 provides core alone, mfe2 provides router alone at a newer minor, mfe3 consumes both at 22.0.5.
const disjointProviders = (): PoolMember[] => [
  member('@ng/core', [
    { tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe1' }, { remote: 'mfe3' }] },
  ]),
  member('@ng/router', [
    { tag: '22.1.0', action: 'share', copies: [{ remote: 'mfe2', req: '^22.1.0' }] },
    { tag: '22.0.5', copies: [{ remote: 'mfe3' }] },
  ]),
];

const isCompatible = (tag: string, range: string) =>
  range === '^22.0.0' ? tag.startsWith('22.') : tag === range.replace('^', '');

describe('coverage is what fails on the defect portfolios', () => {
  it('gives the consumer of two disjoint providers no covering build but itself', () => {
    const members = disjointProviders();
    const builds = liveBuilds(members);
    const consumed = consumedSpecifiers(members);

    // Neither provider covers mfe3: each ships one of the pair.
    expect(covers(builds.get('mfe1')!.coverage, consumed.get('mfe3')!)).toBe(false);
    expect(covers(builds.get('mfe2')!.coverage, consumed.get('mfe3')!)).toBe(false);
    expect(covers(builds.get('mfe3')!.coverage, consumed.get('mfe3')!)).toBe(true);
  });

  // The lockstep pair. Both providers ship core@22.0.5 and agree on it exactly, so no tightening of a tag
  // comparison reaches this — but neither covers {material, cdk}, which coverage says outright.
  it('rejects both providers of a lockstep pair that agree exactly on what they share', () => {
    const members = [
      member('@ng/core', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe1' }, { remote: 'mfe2' }] },
      ]),
      member('@ng/material', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe1' }, { remote: 'mfe3' }] },
      ]),
      member('@ng/cdk', [
        { tag: '22.1.0', action: 'share', copies: [{ remote: 'mfe2', req: '^22.1.0' }] },
        { tag: '22.0.5', copies: [{ remote: 'mfe3' }] },
      ]),
    ];
    const builds = liveBuilds(members);
    const consumed = consumedSpecifiers(members);

    expect(builds.get('mfe1')!.coverage.has('@ng/cdk')).toBe(false);
    expect(builds.get('mfe2')!.coverage.has('@ng/material')).toBe(false);
    expect(covers(builds.get('mfe1')!.coverage, consumed.get('mfe3')!)).toBe(false);
    expect(covers(builds.get('mfe2')!.coverage, consumed.get('mfe3')!)).toBe(false);
  });

  it('still fails on a specifier genuinely absent from the build', () => {
    const members = [
      member('@ng/core', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'partial' }, { remote: 'wide' }] },
      ]),
      member('@ng/core/testing', [{ tag: '22.0.5', copies: [{ remote: 'wide' }] }]),
    ];
    const builds = liveBuilds(members);
    const consumed = consumedSpecifiers(members);

    expect(covers(builds.get('partial')!.coverage, consumed.get('wide')!)).toBe(false);
    expect(covers(builds.get('wide')!.coverage, consumed.get('partial')!)).toBe(true);
  });
});

describe('acceptance', () => {
  it('records every tag a remote’s own range accepts, per member', () => {
    const table = acceptanceTable(disjointProviders(), isCompatible);

    expect([...table.get('mfe3')!.get('@ng/router')!]).toEqual(['22.1.0', '22.0.5']);
    // mfe2 pinned ^22.1.0, so 22.0.5 is not acceptable to it.
    expect([...table.get('mfe2')!.get('@ng/router')!]).toEqual(['22.1.0']);
  });

  it('refuses a build that offers a member at a tag the consumer’s range rejects', () => {
    const members = disjointProviders();
    const table = acceptanceTable(members, isCompatible);
    const builds = liveBuilds(members);
    const consumed = consumedMembers(members);

    // mfe3 accepts router@22.1.0 under ^22.0.0, so mfe2's tag is fine on acceptance alone — coverage is
    // what stops it (above). Reverse the question: mfe2 cannot take mfe3's 22.0.5.
    expect(
      acceptsAll(table, builds.get('mfe3')!.instance, 'mfe2', consumed.get('mfe2')!)
    ).toBe(false);
    expect(acceptsAll(table, builds.get('mfe2')!.instance, 'mfe3', ['@ng/router'])).toBe(true);
  });

  it('refuses a build that does not offer a consumed member at all', () => {
    const members = disjointProviders();
    const table = acceptanceTable(members, isCompatible);

    expect(
      acceptsAll(table, liveBuilds(members).get('mfe1')!.instance, 'mfe3', [
        '@ng/core',
        '@ng/router',
      ])
    ).toBe(false);
  });

  // A remote absent from the table declared nothing in this pool, so it accepts nothing from it.
  it('refuses a consumer it holds no ranges for', () => {
    const members = disjointProviders();
    const table = acceptanceTable(members, isCompatible);

    expect(
      acceptsAll(table, liveBuilds(members).get('mfe1')!.instance, 'stranger', ['@ng/core'])
    ).toBe(false);
  });
});

describe('the witness', () => {
  const witnessed = (members: PoolMember[], remote: string) =>
    isWitnessed(
      consumedSpecifiers(members).get(remote) ?? new Set(),
      sharedTagPerSpecifier(members, new Set()),
      liveBuilds(members)
    );

  // Asked before coverage, because a witnessed remote needs no anchor at all: its whole family already
  // resolves to tags one build shipped together, whichever origin serves each file.
  it('witnesses a remote whose consumed specifiers the shared set offers at one build’s tags', () => {
    const members = [
      member('@ng/core', [
        {
          tag: '22.0.8',
          action: 'share',
          copies: [
            { remote: 'mfe5', entries: { '@ng/core': 'c.js', '@ng/core/rxjs-interop': 'r.js' } },
          ],
        },
      ]),
      member('@ng/core/rxjs-interop', [{ tag: '22.0.8', copies: [{ remote: 'mfe2' }] }]),
    ];

    // mfe2's flat entrypoint has no share version of its own, yet the global map already serves that
    // specifier at 22.0.8 — and mfe5's build is the witness for it. Keyed by name there is nothing to
    // compare, which is why every set here is keyed by specifier.
    expect(witnessed(members, 'mfe2')).toBe(true);
  });

  // All-or-nothing across the family: this is the shape the promise exists for. Taken per specifier the
  // pair would pass, since each half is separately at the shared tag.
  it('declines when the shared set is assembled from two builds and no single build ships the pair', () => {
    const members = disjointProviders();

    expect(witnessed(members, 'mfe3')).toBe(false);
    // mfe1 consumes core alone; one specifier cannot be torn, so its own build witnesses it.
    expect(witnessed(members, 'mfe1')).toBe(true);
  });

  it('declines when a consumed specifier is not in the shared set at all', () => {
    const members = [
      member('@ng/core', [{ tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe1' }] }]),
      member('@ng/cdk', [{ tag: '21.0.0', action: 'scope', copies: [{ remote: 'mfe1' }] }]),
    ];

    expect(witnessed(members, 'mfe1')).toBe(false);
  });
});

describe('assignment', () => {
  const assign = (members: PoolMember[], islanded = new Set<string>()) =>
    assignAnchors({
      builds: liveBuilds(members, islanded),
      acceptance: acceptanceTable(members, isCompatible),
      consumedSpecifiers: consumedSpecifiers(members),
      consumedMembers: consumedMembers(members),
      hosts: hostRemotes(members),
      arrival: arrivalOrder(members),
    });

  it('sends the consumer of two disjoint providers to its own build', () => {
    // The defect, decided correctly: no build covers {core, router} but mfe3's own, so mfe3 serves its
    // whole family rather than being handed one member from each provider.
    expect(assign(disjointProviders()).get('mfe3')).toBeUndefined();
  });

  it('anchors every consumer a covering build accepts onto that one build', () => {
    const members = [
      member('@ng/core', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'full' }, { remote: 'a' }, { remote: 'b' }],
        },
      ]),
      member('@ng/router', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'full' }, { remote: 'a' }, { remote: 'b' }],
        },
      ]),
    ];

    const assignment = assign(members);
    expect(assignment.get('full')).toBeUndefined(); // the anchor runs its own build
    expect(assignment.get('a')).toBe('full');
    expect(assignment.get('b')).toBe('full');
  });

  // Constraint 3: two remotes sharing no member already satisfy the promise, so nothing may be scoped and
  // neither is reassigned. A single anchor per pool is what breaks this.
  it('leaves two remotes that share no member each on its own build', () => {
    const members = [
      member('@ng/core', [{ tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe1' }] }]),
      member('@ng/forms', [{ tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe2' }] }]),
    ];

    const assignment = assign(members);
    expect(assignment.get('mfe1')).toBeUndefined();
    expect(assignment.get('mfe2')).toBeUndefined();
  });

  it('uses several anchors rather than forcing one', () => {
    // Two disjoint halves, each with its own covering build: three anchors, not one.
    const members = [
      member('@ng/core', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'left' }, { remote: 'leftUser' }] },
      ]),
      member('@ng/forms', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'right' }, { remote: 'rightUser' }] },
      ]),
    ];

    const assignment = assign(members);
    expect(assignment.get('leftUser')).toBe('left');
    expect(assignment.get('rightUser')).toBe('right');
    expect(assignment.get('left')).toBeUndefined();
    expect(assignment.get('right')).toBeUndefined();
  });

  it('prefers the host, whose build the browser already holds', () => {
    // The host's copy is first on its version, as basis precedence guarantees on insert.
    const members = [
      member('@ng/core', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'host', host: true }, { remote: 'mfe1' }, { remote: 'mfe2' }],
        },
      ]),
    ];

    const assignment = assign(members);
    // The host anchors both and is never reassigned itself (constraint 5).
    expect(assignment.get('host')).toBeUndefined();
    expect(assignment.get('mfe1')).toBe('host');
    expect(assignment.get('mfe2')).toBe('host');
  });

  // If the host does not cover a consumer, it must still not be pulled onto someone else's build.
  it('leaves the host on its own build even when another remote covers more', () => {
    const members = [
      member('@ng/core', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'host', host: true }, { remote: 'wide' }, { remote: 'user' }],
        },
      ]),
      member('@ng/router', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'wide' }, { remote: 'user' }] },
      ]),
    ];

    const assignment = assign(members);
    expect(assignment.get('host')).toBeUndefined();
    // `wide` covers {core, router} and so anchors `user`; the host covers only core.
    expect(assignment.get('user')).toBe('wide');
  });

  it('never anchors onto a build that is itself deduping', () => {
    const members = [
      member('@ng/core', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'full' }, { remote: 'mid' }, { remote: 'leaf' }],
        },
      ]),
      member('@ng/router', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'full' }, { remote: 'mid' }] },
      ]),
    ];

    const assignment = assign(members);
    // `mid` could cover `leaf`, but `mid` is served by `full`, and a consumer deduping onto a deduping
    // remote inherits that remote's foreign copies.
    expect(assignment.get('mid')).toBe('full');
    expect(assignment.get('leaf')).toBe('full');
  });

  // Gate 1 does not island the host, but it can still fail to be a candidate — it may ship nothing in this
  // pool. It must then anchor nobody and stay on its own build rather than being skipped into somebody
  // else's.
  it('anchors nobody onto a host that is not a candidate build', () => {
    const members = [
      member('@ng/core', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'host', host: true }, { remote: 'user' }],
        },
      ]),
    ];

    const assignment = assign(members, new Set(['host']));
    expect(assignment.get('host')).toBeUndefined();
    expect(assignment.get('user')).toBeUndefined();
  });

  it('excludes an islanded build from anchoring anyone', () => {
    const members = [
      member('@ng/core', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'wide' }, { remote: 'user' }] },
      ]),
      member('@ng/router', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'wide' }, { remote: 'user' }] },
      ]),
    ];

    expect(assign(members).get('user')).toBe('wide');
    // Islanded, so it offers nothing at all — not even members it solely provides.
    expect(assign(members, new Set(['wide'])).get('user')).toBeUndefined();
  });

  // Constraint 12. Manifest order deciding between islanded and silently split is the defect this whole
  // change exists for, so the assignment may not depend on it either.
  it('reaches the same assignment whatever order the copies arrive in', () => {
    const forward = [
      member('@ng/core', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'a' }, { remote: 'b' }, { remote: 'c' }],
        },
      ]),
      member('@ng/router', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'a' }, { remote: 'b' }, { remote: 'c' }],
        },
      ]),
    ];
    const reversed = [
      member('@ng/core', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'c' }, { remote: 'b' }, { remote: 'a' }],
        },
      ]),
      member('@ng/router', [
        {
          tag: '22.0.5',
          action: 'share',
          copies: [{ remote: 'c' }, { remote: 'b' }, { remote: 'a' }],
        },
      ]),
    ];

    // Same set of anchors either way: one build serves all three, and which one is decided by arrival then
    // name rather than by input order alone.
    const anchorsOf = (a: Map<string, string | undefined>) =>
      new Set([...a.values()].filter(v => v !== undefined));
    expect(anchorsOf(assign(forward)).size).toBe(1);
    expect(anchorsOf(assign(reversed)).size).toBe(1);
    expect([...assign(forward).keys()].sort()).toEqual([...assign(reversed).keys()].sort());
  });
});
