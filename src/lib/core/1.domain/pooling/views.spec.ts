import type { SharedExternal, SharedVersion, SharedVersionAction } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { hostRemotes } from './views';
import type { PoolMember } from './membership';

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
