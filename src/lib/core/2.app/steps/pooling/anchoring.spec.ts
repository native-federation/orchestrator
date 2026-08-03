import type { SharedExternal, SharedVersion, SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import {
  acceptanceTable,
  acceptsAll,
  arrivalOrder,
  assignAnchors,
  consumedSpecifiers,
  coveragePerBuild,
  covers,
  electedTags,
  hostRemotes,
  sharedTagPerSpecifier,
  tagsPerBuild,
  witnessedSpecifiers,
} from './anchoring';
import { buildInstances, consumedMembers } from './family-instance';
import type { PoolMember } from './pool.types';

/**
 * The primitives behind the provenance promise, tested on the portfolios that reproduce the defect it
 * fixes — `e2e/pooling/provenance.e2e.spec.ts` runs the same shapes in a browser. Nothing here is wired
 * into production yet; election reads these from the iteration after this one.
 *
 * Two shapes recur and are worth naming up front:
 *  - *disjoint providers*: mfe1 solely provides core, mfe2 solely provides router, mfe3 consumes both.
 *    No build in the portfolio ships the pair mfe3 ends up running.
 *  - *the lockstep pair*: two providers overlap and agree exactly on what they share, yet the coupled
 *    pair is in neither build. No tag comparison can reach it, which is why coverage is the test.
 */

// A remote's copy of one member: `at` is the tag, `req` its own range, `entries` the specifiers it
// carries (defaulting to just the member itself, which is what a flat build emits).
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

describe('anchoring', () => {
  describe('coverage, keyed by specifier', () => {
    it('gathers every specifier a build serves, across members', () => {
      const coverage = coveragePerBuild(disjointProviders());

      expect([...coverage.get('mfe1')!.keys()]).toEqual(['@ng/core']);
      expect([...coverage.get('mfe3')!.keys()]).toEqual(['@ng/core', '@ng/router']);
      expect(coverage.get('mfe3')!.get('@ng/router')).toBe('@ng/router.js');
    });

    // The lever worth the most on the eleven-remote capture. A flat remote declares
    // `@ng/core/testing` as its own external; a dense one carries the same specifier as an entry of
    // `@ng/core`. In external-name space those two build shapes are {core, core/testing} against
    // {core}, so neither covers the other and both self-serve — for a build-tool reason with no
    // provenance content whatsoever. In specifier space they serve the identical set and either can
    // anchor the other.
    it('lets a dense and a flat build of the same specifiers cover each other', () => {
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

      const coverage = coveragePerBuild(members);
      const consumed = consumedSpecifiers(members);

      expect([...coverage.get('dense')!.keys()].sort()).toEqual(['@ng/core', '@ng/core/testing']);
      expect([...coverage.get('flat')!.keys()].sort()).toEqual(['@ng/core', '@ng/core/testing']);
      expect(covers(coverage.get('dense')!, consumed.get('flat')!)).toBe(true);
      expect(covers(coverage.get('flat')!, consumed.get('dense')!)).toBe(true);
    });

    it('still fails on a specifier genuinely absent from the build', () => {
      const members = [
        member('@ng/core', [
          {
            tag: '22.0.5',
            action: 'share',
            copies: [{ remote: 'partial' }, { remote: 'wide' }],
          },
        ]),
        member('@ng/core/testing', [{ tag: '22.0.5', copies: [{ remote: 'wide' }] }]),
      ];

      const coverage = coveragePerBuild(members);
      const consumed = consumedSpecifiers(members);

      expect(covers(coverage.get('partial')!, consumed.get('wide')!)).toBe(false);
      expect(covers(coverage.get('wide')!, consumed.get('partial')!)).toBe(true);
    });

    it('excludes a scoped copy, which is about to self-serve', () => {
      const members = [
        member('@ng/core', [
          { tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe1' }] },
          { tag: '21.0.0', action: 'scope', copies: [{ remote: 'legacy' }] },
        ]),
      ];

      expect(coveragePerBuild(members).has('legacy')).toBe(false);
      // Still consumed, though — it has to be able to import what it declares.
      expect([...consumedSpecifiers(members).get('legacy')!]).toEqual(['@ng/core']);
    });

    it('excludes an islanded build entirely', () => {
      const coverage = coveragePerBuild(disjointProviders(), new Set(['mfe1']));
      expect(coverage.has('mfe1')).toBe(false);
      expect(coverage.has('mfe2')).toBe(true);
    });
  });

  describe('coverage is what fails on the defect portfolios', () => {
    it('gives the consumer of two disjoint providers no covering build but itself', () => {
      const members = disjointProviders();
      const coverage = coveragePerBuild(members);
      const consumed = consumedSpecifiers(members);

      // Neither provider covers mfe3: each ships one of the pair.
      expect(covers(coverage.get('mfe1')!, consumed.get('mfe3')!)).toBe(false);
      expect(covers(coverage.get('mfe2')!, consumed.get('mfe3')!)).toBe(false);
      expect(covers(coverage.get('mfe3')!, consumed.get('mfe3')!)).toBe(true);
    });

    // The lockstep pair. Both providers ship core@22.0.5 and agree on it exactly, so no tightening of a
    // tag comparison reaches this — but neither covers {material, cdk}, which coverage says outright.
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
      const coverage = coveragePerBuild(members);
      const consumed = consumedSpecifiers(members);

      expect(coverage.get('mfe1')!.has('@ng/cdk')).toBe(false);
      expect(coverage.get('mfe2')!.has('@ng/material')).toBe(false);
      expect(covers(coverage.get('mfe1')!, consumed.get('mfe3')!)).toBe(false);
      expect(covers(coverage.get('mfe2')!, consumed.get('mfe3')!)).toBe(false);
    });
  });

  describe('acceptance', () => {
    const isCompatible = (tag: string, range: string) =>
      range === '^22.0.0' ? tag.startsWith('22.') : tag === range.replace('^', '');

    it('records every tag a remote’s own range accepts, per member', () => {
      const table = acceptanceTable(disjointProviders(), isCompatible);

      expect([...table.get('mfe3')!.get('@ng/router')!]).toEqual(['22.1.0', '22.0.5']);
      // mfe2 pinned ^22.1.0, so 22.0.5 is not acceptable to it.
      expect([...table.get('mfe2')!.get('@ng/router')!]).toEqual(['22.1.0']);
    });

    it('refuses a build that offers a member at a tag the consumer’s range rejects', () => {
      const members = disjointProviders();
      const table = acceptanceTable(members, isCompatible);
      const instances = buildInstances(members);
      const consumed = consumedMembers(members);

      // mfe3 accepts router@22.1.0 under ^22.0.0, so mfe2's tag is fine on acceptance alone —
      // coverage is what stops it (above). Reverse the question: mfe2 cannot take mfe3's 22.0.5.
      expect(acceptsAll(table, instances.get('mfe3')!, 'mfe2', consumed.get('mfe2')!)).toBe(false);
      expect(acceptsAll(table, instances.get('mfe2')!, 'mfe3', ['@ng/router'])).toBe(true);
    });

    it('refuses a build that does not offer a consumed member at all', () => {
      const members = disjointProviders();
      const table = acceptanceTable(members, isCompatible);
      const instances = buildInstances(members);

      expect(acceptsAll(table, instances.get('mfe1')!, 'mfe3', ['@ng/core', '@ng/router'])).toBe(
        false
      );
    });

    // A remote absent from the table declared nothing in this pool, so it accepts nothing from it.
    it('refuses a consumer it holds no ranges for', () => {
      const members = disjointProviders();
      const table = acceptanceTable(members, isCompatible);

      expect(
        acceptsAll(table, buildInstances(members).get('mfe1')!, 'stranger', ['@ng/core'])
      ).toBe(false);
    });
  });

  describe('the same-tag witness', () => {
    // A remote may take a member offered at exactly its own tag with no coverage test: its own build
    // shipped that version beside the rest of its family, so its own build is the witness. This is what
    // brings the production capture back to +0%, and why the criterion is "one build, *or* every member
    // at the remote's own tag".
    it('witnesses the specifiers the shared set already offers at the remote’s own tag', () => {
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
      const own = tagsPerBuild(members).get('mfe2')!;
      const shared = sharedTagPerSpecifier(members, new Set());

      // mfe2's flat entrypoint has no share version of its own, yet the global map already serves that
      // specifier at 22.0.8 — the tag mfe2 itself ships. Keyed by name there is nothing to compare.
      expect(witnessedSpecifiers(own, shared)).toEqual(new Set(['@ng/core/rxjs-interop']));
    });

    it('witnesses nothing when the shared tag differs, however close', () => {
      const members = [
        member('@ng/core', [
          { tag: '22.0.8', action: 'share', copies: [{ remote: 'mfe5' }] },
          { tag: '22.0.6', copies: [{ remote: 'mfe11' }] },
        ]),
      ];
      const shared = sharedTagPerSpecifier(members, new Set());

      // One patch apart and on one minor line, which the shipped agreement gate calls agreement. The
      // witness reads identity only, so it declines — this is the +17 remote on the eleven-remote
      // capture, and recovering it would mean putting version distance back into the rule.
      expect(witnessedSpecifiers(tagsPerBuild(members).get('mfe11')!, shared)).toEqual(new Set());
      expect(witnessedSpecifiers(tagsPerBuild(members).get('mfe5')!, shared)).toEqual(
        new Set(['@ng/core'])
      );
    });

    // The witness compares the consumer's own tag, so it must not read a tag off a copy that is about
    // to self-serve — mirroring coverage, which excludes the same copies.
    it('reads no tag from a scoped or islanded copy', () => {
      const members = [
        member('@ng/core', [
          { tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe1' }, { remote: 'mfe2' }] },
          { tag: '21.0.0', action: 'scope', copies: [{ remote: 'legacy' }] },
        ]),
      ];

      expect(tagsPerBuild(members).has('legacy')).toBe(false);
      expect(tagsPerBuild(members, new Set(['mfe2'])).has('mfe2')).toBe(false);
      expect(
        tagsPerBuild(members, new Set(['mfe2']))
          .get('mfe1')!
          .get('@ng/core')
      ).toBe('22.0.5');
    });

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
  });

  describe('the retained elected tag', () => {
    // Needed because a provider can lose its `share` version for a reason unrelated to its build being
    // incoherent — being disqualified as an anchor — and the member must still be mapped globally for
    // the remotes that are at its version.
    it('records what determine elected per member, before pooling rewrites anything', () => {
      expect([...electedTags(disjointProviders())]).toEqual([
        ['@ng/core', '22.0.5'],
        ['@ng/router', '22.1.0'],
      ]);
    });

    it('records nothing for a member with no shared version', () => {
      const members = [
        member('@ng/cdk', [{ tag: '22.1.0', action: 'scope', copies: [{ remote: 'a' }] }]),
      ];
      expect(electedTags(members).size).toBe(0);
    });
  });

  describe('the host', () => {
    // Only the *version* carries a host flag, never the individual copy, so the host is identified as
    // `remotes[0]` of a host-contributed version — which is sound because basis precedence sorts the
    // host's own copy first on insert (see docs/version-resolver.md §"The basis of a version"). Fixtures
    // have to honour that ordering or they encode a record the cache cannot produce.
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
      expect(hostRemotes(disjointProviders())).toEqual(new Set());
    });
  });

  describe('assignment', () => {
    const isCompatible = (tag: string, range: string) =>
      range === '^22.0.0' ? tag.startsWith('22.') : tag === range.replace('^', '');

    const assign = (members: PoolMember[], islanded = new Set<string>()) =>
      assignAnchors({
        instances: buildInstances(members, islanded),
        coverage: coveragePerBuild(members, islanded),
        acceptance: acceptanceTable(members, isCompatible),
        consumedSpecifiers: consumedSpecifiers(members),
        consumedMembers: consumedMembers(members),
        hosts: hostRemotes(members),
        arrival: arrivalOrder(members),
      });

    it('sends the consumer of two disjoint providers to its own build', () => {
      // The defect, decided correctly: no build covers {core, router} but mfe3's own, so mfe3 serves
      // its whole family rather than being handed one member from each provider.
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

    // Constraint 3: two remotes sharing no member already satisfy the promise, so nothing may be
    // scoped and neither is reassigned. A single anchor per pool is what breaks this.
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
          {
            tag: '22.0.5',
            action: 'share',
            copies: [{ remote: 'right' }, { remote: 'rightUser' }],
          },
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
      // `mid` could cover `leaf`, but `mid` is served by `full`, and a consumer deduping onto a
      // deduping remote inherits that remote's foreign copies.
      expect(assignment.get('mid')).toBe('full');
      expect(assignment.get('leaf')).toBe('full');
    });

    // Gate 1 does not island the host, but it can still fail to be a candidate — it may ship nothing in
    // this pool. It must then anchor nobody and stay on its own build rather than being skipped into
    // somebody else's.
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

    // Constraint 12. Manifest order deciding between islanded and silently split is the defect this
    // whole change exists for, so the assignment may not depend on it either.
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

      // Same set of anchors either way: one build serves all three, and which one is decided by
      // arrival then name rather than by input order alone.
      const anchorsOf = (a: Map<string, string | undefined>) =>
        new Set([...a.values()].filter(v => v !== undefined));
      expect(anchorsOf(assign(forward)).size).toBe(1);
      expect(anchorsOf(assign(reversed)).size).toBe(1);
      expect([...assign(forward).keys()].sort()).toEqual([...assign(reversed).keys()].sort());
    });
  });
});
