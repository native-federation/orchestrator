import type { SharedExternal, SharedVersion, SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { acceptanceTable, acceptsAll, covers } from './subpool-fit';
import { committedView, consumedMembers, consumedSpecifiers } from './pool-views';
import type { PoolMember } from './pool.types';

/**
 * The checks a remote loaded at runtime is held to before it may take a committed build — coverage and
 * acceptance — tested on the portfolios that reproduce the defect they exist for.
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
    const builds = committedView(members).builds;
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
    const builds = committedView(members).builds;
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
    const builds = committedView(members).builds;
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
    const builds = committedView(members).builds;
    const consumed = consumedMembers(members);

    // mfe3 accepts router@22.1.0 under ^22.0.0, so mfe2's tag is fine on acceptance alone — coverage is
    // what stops it (above). Reverse the question: mfe2 cannot take mfe3's 22.0.5.
    expect(acceptsAll(table, builds.get('mfe3')!.instance, 'mfe2', consumed.get('mfe2')!)).toBe(
      false
    );
    expect(acceptsAll(table, builds.get('mfe2')!.instance, 'mfe3', ['@ng/router'])).toBe(true);
  });

  it('refuses a build that does not offer a consumed member at all', () => {
    const members = disjointProviders();
    const table = acceptanceTable(members, isCompatible);

    expect(
      acceptsAll(table, committedView(members).builds.get('mfe1')!.instance, 'mfe3', [
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
      acceptsAll(table, committedView(members).builds.get('mfe1')!.instance, 'stranger', [
        '@ng/core',
      ])
    ).toBe(false);
  });
});
