import type { SharedExternal, SharedVersion, SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { acceptanceTable, acceptsAll } from './subpool-fit';
import { committedView, consumedMembers } from 'lib/core/1.domain/pooling/views';
import type { PoolMember } from 'lib/core/1.domain/pooling/membership';
import { acceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';

/**
 * Acceptance, the check a remote loaded at runtime is held to before it may take a committed build, on the
 * *disjoint providers* portfolio: mfe1 solely provides core, mfe2 solely provides router, mfe3 consumes both.
 * Coverage, the other check, is tested on the flow in `pooling.dynamic.spec.ts`, as is acceptance ("joins
 * the island whose tags its range accepts").
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

const accepts = acceptsTag(
  (tag: string, range: string) =>
    range === '^22.0.0' ? tag.startsWith('22.') : tag === range.replace('^', ''),
  createVersionCheck().compare
);

describe('acceptance', () => {
  it('records every tag a remote’s own range accepts, per member', () => {
    const table = acceptanceTable(disjointProviders(), accepts);

    expect([...table.get('mfe3')!.get('@ng/router')!]).toEqual(['22.1.0', '22.0.5']);
    // mfe2 pinned ^22.1.0, so 22.0.5 is not acceptable to it.
    expect([...table.get('mfe2')!.get('@ng/router')!]).toEqual(['22.1.0']);
  });

  it('refuses a build that offers a member at a tag the consumer’s range rejects', () => {
    const members = disjointProviders();
    const table = acceptanceTable(members, accepts);
    const builds = committedView(members).builds;
    const consumed = consumedMembers(members);

    // mfe3 accepts router@22.1.0 under ^22.0.0, so mfe2's tag is fine on acceptance alone — coverage is
    // what stops it. Reverse the question: mfe2 cannot take mfe3's 22.0.5.
    expect(acceptsAll(table, builds.get('mfe3')!.tagByMember, 'mfe2', consumed.get('mfe2')!)).toBe(
      false
    );
    expect(acceptsAll(table, builds.get('mfe2')!.tagByMember, 'mfe3', ['@ng/router'])).toBe(true);
  });

  it('refuses a build that does not offer a consumed member at all', () => {
    const members = disjointProviders();
    const table = acceptanceTable(members, accepts);

    expect(
      acceptsAll(table, committedView(members).builds.get('mfe1')!.tagByMember, 'mfe3', [
        '@ng/core',
        '@ng/router',
      ])
    ).toBe(false);
  });

  // A remote absent from the table declared nothing in this pool, so it accepts nothing from it.
  it('refuses a consumer it holds no ranges for', () => {
    const members = disjointProviders();
    const table = acceptanceTable(members, accepts);

    expect(
      acceptsAll(table, committedView(members).builds.get('mfe1')!.tagByMember, 'stranger', [
        '@ng/core',
      ])
    ).toBe(false);
  });
});
