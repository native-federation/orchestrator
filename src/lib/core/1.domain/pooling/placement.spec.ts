import type { SharedVersion, SharedVersionMeta } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { acceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { electVariants } from './election';
import type { PoolMember } from './membership';
import { electedPlacement, memberRecord, missesOf, safePlacement } from './placement';
import { hostRemotes } from './views';

/**
 * The records the init step writes are computed here, before any write: so a failure inside them leaves the
 * stored record untouched (D3), and nothing here may change what it reads. Which rows they hold is the step's
 * spec (`pool-shared-externals.spec.ts`) and the containment spec's.
 */
const { compare, isCompatible } = createVersionCheck();

// A pool already elected once: copies carry the verdicts of last time, which a new record must not keep and
// the read must not strip from the stored one.
const pool = (): PoolMember[] =>
  ['@x/core', '@x/common'].map(name => ({
    name,
    external: {
      dirty: true,
      poolName: 'x',
      poolWinner: 'team/a',
      versions: [
        {
          tag: '17.0.0',
          host: true,
          action: 'share',
          remotes: [
            mockVersionRemote('team/h', name, { requiredVersion: '^17.0.0' }),
            mockVersionRemote('team/a', name, { requiredVersion: '^17.0.0' }),
          ],
        },
        {
          tag: '16.0.0',
          host: false,
          action: 'scope',
          remotes: [
            mockVersionRemote('team/b', name, {
              requiredVersion: '~16.0.0',
              poolCause: 'incompatible',
            }),
            mockVersionRemote('team/c', name, { requiredVersion: '~16.0.0', servedBy: 'team/b' }),
          ],
        },
      ] satisfies SharedVersion[],
    },
  }));

describe('placement', () => {
  it('memberRecord reads an elected pool without changing it', () => {
    const members = pool();
    const before = structuredClone(members);
    const hosts = hostRemotes(members);
    const election = electVariants({
      members,
      acceptsTag: acceptsTag(isCompatible, compare),
      hosts,
      arrival: new Map([
        ['team/h', 0],
        ['team/a', 1],
        ['team/b', 2],
        ['team/c', 3],
      ]),
      compare,
      latestFirst: false,
    });
    const placed = electedPlacement('x', election, missesOf(election), hosts, compare);

    const records = members.map(m => memberRecord(m, placed));

    expect(members).toEqual(before);
    // b and c run one build at 16.0.0: a subpool, so the record is new and not a copy of the stored one.
    expect(records[0]!.versions.map(v => `${v.tag}:${v.action}`)).toEqual([
      '17.0.0:share',
      '16.0.0:skip',
    ]);
  });

  it('safePlacement and memberRecord read a failed pool without changing it', () => {
    const members = pool();
    const before = structuredClone(members);

    const placed = safePlacement('x', members, compare);
    const records = members.map(m => memberRecord(m, placed));

    expect(members).toEqual(before);
    expect(placed.winner).toBe('team/h');
    expect(records[0]!.versions.map(v => `${v.tag}:${v.action}`)).toEqual([
      '17.0.0:share',
      '17.0.0:scope',
      '16.0.0:scope',
    ]);
  });
});

// The fallback for a pool whose election failed (D3), read directly: the step's containment spec reaches it
// only through an injected failure.
describe('safePlacement', () => {
  type Row = { tag: string; host?: boolean; remotes: [string, Record<string, string>?][] };
  // One member, rows as stored (newest first, as `commit()` leaves them); a copy's entries default to the
  // member itself.
  const member = (name: string, rows: Row[]): PoolMember => ({
    name,
    external: {
      dirty: true,
      poolName: 'x',
      poolWinner: 'team/z',
      versions: rows.map<SharedVersion>(row => ({
        tag: row.tag,
        host: row.host ?? false,
        action: 'skip',
        remotes: row.remotes.map<SharedVersionMeta>(([remote, entries]) =>
          mockVersionRemote(remote, name, {
            requiredVersion: '^17.0.0',
            entries: entries ?? { [name]: `${remote}-${name}.js` },
          })
        ),
      })),
    },
  });
  const rows = (members: PoolMember[], name: string) => {
    const placed = safePlacement('x', members, compare);
    return memberRecord(
      members.find(m => m.name === name)!,
      placed
    ).versions.map(
      v => `${v.tag}:${v.action}${v.host ? ':host' : ''}:[${v.remotes.map(r => r.name)}]`
    );
  };

  it("keeps the host's build global over the first arrival", () => {
    const members = [
      member('x', [
        { tag: '17.0.0', remotes: [['team/a'], ['team/b']] },
        { tag: '16.0.0', host: true, remotes: [['team/h']] },
      ]),
      member('y', [{ tag: '16.0.0', host: true, remotes: [['team/h']] }]),
    ];

    expect(safePlacement('x', members, compare).winner).toBe('team/h');
    expect(rows(members, 'x')).toEqual([
      '17.0.0:scope:[team/a,team/b]',
      '16.0.0:share:host:[team/h]',
    ]);
  });

  it('keeps the first arrival global without a host', () => {
    const members = [
      member('x', [
        { tag: '17.0.0', remotes: [['team/b'], ['team/a']] },
        { tag: '16.0.0', remotes: [['team/c']] },
      ]),
      member('y', [{ tag: '17.0.0', remotes: [['team/a'], ['team/b']] }]),
    ];

    expect(safePlacement('x', members, compare).winner).toBe('team/b');
    expect(rows(members, 'x')).toEqual([
      '17.0.0:share:[team/b]',
      '17.0.0:scope:[team/a]',
      '16.0.0:scope:[team/c]',
    ]);
  });

  it('places every other remote itself, uncovered', () => {
    const members = [
      member('x', [
        { tag: '17.0.0', remotes: [['team/a'], ['team/b']] },
        { tag: '16.0.0', remotes: [['team/c']] },
      ]),
      member('y', [{ tag: '17.0.0', remotes: [['team/a'], ['team/d']] }]),
    ];

    expect(Object.fromEntries(safePlacement('x', members, compare).placements)).toEqual({
      'team/a': { kind: 'global' },
      'team/b': { kind: 'self', cause: 'uncovered' },
      'team/c': { kind: 'self', cause: 'uncovered' },
      'team/d': { kind: 'self', cause: 'uncovered' },
    });
    const copies = memberRecord(members[0]!, safePlacement('x', members, compare)).versions.flatMap(
      v => v.remotes.map(r => `${r.name}:${r.poolCause ?? '-'}:${r.servedBy ?? '-'}`)
    );
    expect(copies.sort()).toEqual(['team/a:-:-', 'team/b:uncovered:-', 'team/c:uncovered:-']);
  });

  // D28: the shared tag is read off the winner's build alone, its first row per member taken whole. Reading
  // every row, h's 16.0.0 row would put `x/testing` at 16.0.0, and b's `x/testing` would share that row.
  it("shares the tag of the winner's first row of a member", () => {
    const members = [
      member('x', [
        { tag: '18.0.0', remotes: [['team/b', { 'x/testing': 'b-testing.js' }]] },
        { tag: '17.0.0', host: true, remotes: [['team/h', { x: 'h-x-17.js' }]] },
        { tag: '16.0.0', remotes: [['team/h', { x: 'h-x-16.js', 'x/testing': 'h-testing.js' }]] },
      ]),
      member('y', [{ tag: '17.0.0', host: true, remotes: [['team/h']] }]),
    ];

    expect([...safePlacement('x', members, compare).coverage]).toEqual([
      ['x', '17.0.0'],
      ['y', '17.0.0'],
    ]);
    // Tags and actions only: the host flag on h's second row is a quirk of the malformed record.
    expect(rows(members, 'x').map(row => row.replace(':host', ''))).toEqual([
      '18.0.0:scope:[team/b]',
      '17.0.0:share:[team/h]',
      '16.0.0:skip:[team/h]',
    ]);
  });

  it('stores no winner, not even the one the last election stored', () => {
    const members = [
      member('x', [{ tag: '17.0.0', remotes: [['team/a'], ['team/z']] }]),
      member('y', [{ tag: '17.0.0', remotes: [['team/a'], ['team/z']] }]),
    ];
    const placed = safePlacement('x', members, compare);

    for (const m of members) expect(memberRecord(m, placed)).not.toHaveProperty('poolWinner');
  });
});
