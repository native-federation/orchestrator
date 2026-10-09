import type { SharedExternal, SharedVersion, SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { buildOf, copiesByRemote } from './builds';
import type { PoolMember } from './membership';

/**
 * What one remote's build ships, read off the stored record. The election and the dynamic gate both read
 * builds through these two functions, so this is where the record's oddities are pinned once.
 */

// A remote's copy of one member: `req` is its own range, `entries` the specifiers it carries (defaulting to
// just the member itself, which is what a flat build emits).
type Copy = {
  remote: string;
  req?: string;
  entries?: Record<string, string>;
  host?: boolean;
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
        })
      ),
    })),
  } satisfies SharedExternal,
});

const buildFor = (owner: string, members: PoolMember[]) =>
  buildOf(owner, copiesByRemote(members).get(owner)!);

describe('a build read from the record', () => {
  // A record the orchestrator never writes itself: b lists `x` twice, and only the second row carries
  // `x/extra`. A build ships one copy per member, so the first row is taken whole, entries included: b
  // never covers a specifier at a tag it does not ship `x` at. The gate once took `x/extra` from the
  // second row, at 1.0.0, where the election ignored that row.
  it('reads a duplicated row as the first one, entries included', () => {
    const members = [
      member('x', [
        { tag: '1.0.1', copies: [{ remote: 'b', req: '~1.0.0', entries: { x: 'x.js' } }] },
        {
          tag: '1.0.0',
          copies: [
            { remote: 'b', req: '~1.0.0', entries: { x: 'x-100.js', 'x/extra': 'extra.js' } },
          ],
        },
      ]),
    ];
    const build = buildFor('b', members);

    expect(build.tags.get('x')).toBe('1.0.1');
    expect(build.tags.has('x/extra')).toBe(false);
  });

  // Flat and dense in one build: `x/sub` is an entry of r's dense `x` at 1.0.0 and r's own flat package at
  // 2.0.0. The build reads its tag from the first copy in pool order.
  it.each([
    ['dense first', ['x', 'x/sub'], '1.0.0'],
    ['flat first', ['x/sub', 'x'], '2.0.0'],
  ])('takes a specifier two members list from the first in pool order (%s)', (_, order, first) => {
    const byName: Record<string, PoolMember> = {
      x: member('x', [
        {
          tag: '1.0.0',
          copies: [{ remote: 'r', req: '^1.0.0', entries: { x: 'x.js', 'x/sub': 'dense-sub.js' } }],
        },
      ]),
      'x/sub': member('x/sub', [{ tag: '2.0.0', copies: [{ remote: 'r', req: '^2.0.0' }] }]),
    };

    expect(
      buildFor(
        'r',
        order.map(name => byName[name]!)
      ).tags.get('x/sub')
    ).toBe(first);
  });

  it('is no host when no version came from a host', () => {
    const members = [
      member('@angular/core', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'mfe-b', req: '~22.0.5' }] },
        { tag: '22.1.0', copies: [{ remote: 'mfe-a' }] },
      ]),
    ];
    expect(buildFor('mfe-a', members).host).toBe(false);
    expect(buildFor('mfe-b', members).host).toBe(false);
  });

  // Pins intent, not a record the orchestrator writes: any copy from a host row marks the build, even when
  // another of its copies sits on a non-host row.
  it('is the host when any of its copies came from a host row', () => {
    const members = [
      member('@angular/core', [
        { tag: '22.0.5', action: 'share', copies: [{ remote: 'shell', host: true }] },
      ]),
      member('@angular/common', [{ tag: '22.0.5', copies: [{ remote: 'shell' }] }]),
    ];
    expect(buildFor('shell', members).host).toBe(true);
  });
});
