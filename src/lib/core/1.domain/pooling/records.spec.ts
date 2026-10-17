import type { SharedExternal, SharedVersion, shareScope } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { createAcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { elect } from './election';
import type { PoolMember } from './membership';
import { memberRecord, renamedRecords } from './records';

/**
 * The records the init step writes are computed here, before any write, and nothing here may change what it
 * reads. Which rows they hold is the step's spec (`pool-shared-externals.spec.ts`).
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

describe('memberRecord', () => {
  it('memberRecord reads an elected pool without changing it', () => {
    const members = pool();
    const before = structuredClone(members);
    const election = elect({
      members,
      acceptsTag: createAcceptsTag(isCompatible, compare),
      compare,
      latestFirst: false,
    });
    const placed = { ...election, poolName: 'x' };

    const records = members.map(m => memberRecord(m, placed, compare));

    expect(members).toStrictEqual(before);
    // b and c run one build at 16.0.0: a subpool, so the record is new and not a copy of the stored one.
    expect(records[0]!.versions.map(v => `${v.tag}:${v.action}`)).toEqual([
      '17.0.0:share',
      '16.0.0:skip',
    ]);
  });

  // A dynamic load stores its moved copy `cached`; the gate reads that flag as "on the global map", but the
  // map after a re-election is rebuilt from scratch, and generate-import-map re-marks what it publishes.
  it('writes every copy uncached, whatever the stored flag', () => {
    const members = pool();
    for (const { external } of members)
      for (const version of external.versions)
        for (const meta of version.remotes) meta.cached = true;
    const election = elect({
      members,
      acceptsTag: createAcceptsTag(isCompatible, compare),
      compare,
      latestFirst: false,
    });
    const placed = { ...election, poolName: 'x' };

    const flags = members.flatMap(m =>
      memberRecord(m, placed, compare).versions.flatMap(v => v.remotes.map(r => r.cached))
    );

    expect(flags).toEqual(Array(8).fill(false));
  });
});

describe('memberRecord of a package whose copies ship different entrypoints', () => {
  // The host r2 ships the root at 17.2.0 and sub at 17.2.1; r7's dense copy of the root, listed first, ships
  // only sub.
  const remote = (name: string, entries: string[]) => ({
    ...mockVersionRemote(name, '@y/pkg', { requiredVersion: '*' }),
    entries: Object.fromEntries(entries.map(e => [e, `${e.slice(1).replace(/\//g, '_')}.js`])),
  });
  const row = (
    tag: string,
    host: boolean,
    ...remotes: SharedVersion['remotes']
  ): SharedVersion => ({
    tag,
    host,
    action: 'share',
    remotes,
  });
  const members = (): PoolMember[] => [
    {
      name: '@y/pkg',
      external: {
        dirty: true,
        poolName: 'y',
        versions: [
          row('18.0.1', false, remote('r7', ['@y/pkg/sub'])),
          row('17.2.0', true, remote('r2', ['@y/pkg'])),
        ],
      },
    },
    {
      name: '@y/pkg/sub',
      external: {
        dirty: true,
        poolName: 'y',
        versions: [row('17.2.1', true, remote('r2', ['@y/pkg/sub']))],
      },
    },
  ];

  it("shares the copy at its own specifier's global tag, not at a secondary's", () => {
    const pool = members();
    const election = elect({
      members: pool,
      acceptsTag: createAcceptsTag(isCompatible, compare),
      compare,
      latestFirst: false,
    });

    const record = memberRecord(pool[0]!, { ...election, poolName: 'y' }, compare);

    expect(record.versions.find(v => v.action === 'share')?.tag).toBe('17.2.0');
  });
});

describe('renamedRecords', () => {
  const pooled = (poolName?: string): SharedExternal => ({
    dirty: false,
    ...(poolName === undefined ? {} : { poolName }),
    poolWinner: 'team/a',
    versions: [
      {
        tag: '17.0.0',
        host: false,
        action: 'skip',
        remotes: [mockVersionRemote('team/b', '@framework/core', { servedBy: 'team/c' })],
      },
    ],
  });
  const pool = (scope: shareScope, ...names: string[]) =>
    names.map(name => ({ name, external: scope[name]! }));

  // A dynamic load writes the pools it judged; one it merged renames committed members it never rewrote.
  it('names a member that stored no pool yet, and skips one already named right', () => {
    const scope: shareScope = { core: pooled('framework'), common: pooled() };

    expect(renamedRecords(scope, new Map([['framework', pool(scope, 'core', 'common')]]))).toEqual([
      ['common', { ...pooled(), poolName: 'framework' }],
    ]);
  });

  it('renames a member stored under another name, and nothing in no pool', () => {
    const scope: shareScope = { '@framework/core': pooled('old'), stale: pooled('gone') };

    expect(renamedRecords(scope, new Map([['angular', pool(scope, '@framework/core')]]))).toEqual([
      ['@framework/core', { ...pooled('old'), poolName: 'angular' }],
    ]);
  });

  it('reads the stored name from the scope, not from the member it was handed', () => {
    // The dynamic path passes the committed records merged with what it just wrote.
    const before = pooled('old');
    const scope: shareScope = { a: pooled('p') };

    expect(renamedRecords(scope, new Map([['p', [{ name: 'a', external: before }]]]))).toEqual([]);
  });

  it('keeps poolWinner and servedBy on a rename: the pool was not re-elected', () => {
    const record = pooled('framework');
    const scope: shareScope = { '@framework/core': record };

    expect(renamedRecords(scope, new Map([['angular', pool(scope, '@framework/core')]]))).toEqual([
      ['@framework/core', { ...pooled('framework'), poolName: 'angular' }],
    ]);
    expect(record).toEqual(pooled('framework'));
  });
});

// The host h ships core alone; r ships core and interop at h's tag as flat externals of their own, so each
// is a member of its own. Round 1 borrows nothing, so r leaves for its family: interop is uncovered, and its
// core must leave with it. Taking the global core while interop scopes would run core from h's build beside
// r's interop.
describe('a remote that leaves the pool for its family', () => {
  it('takes no global files for one flat member while another scopes', () => {
    const copy = (remote: string, name: string) =>
      mockVersionRemote(remote, name, { requiredVersion: '~17.0.0', strictVersion: false });
    const members: PoolMember[] = [
      {
        name: '@fw/core',
        external: {
          dirty: true,
          versions: [
            {
              tag: '17.0.0',
              host: true,
              action: 'share',
              remotes: [copy('h', '@fw/core'), copy('r', '@fw/core')],
            },
          ],
        },
      },
      {
        name: '@fw/core/interop',
        external: {
          dirty: true,
          versions: [
            {
              tag: '17.0.0',
              host: false,
              action: 'share',
              remotes: [copy('r', '@fw/core/interop')],
            },
          ],
        },
      },
    ];
    for (const order of [members, [...members].reverse()]) {
      const election = elect({
        members: order,
        acceptsTag: createAcceptsTag(isCompatible, compare),
        compare,
        latestFirst: false,
      });
      const placed = { ...election, poolName: 'fw' };

      const rows = members.map(m =>
        memberRecord(m, placed, compare).versions.map(
          v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name).join(',')}]`
        )
      );

      expect(placed.placements.get('r')).toEqual({ kind: 'self', cause: 'uncovered' });
      expect(rows).toEqual([['17.0.0:share:[h]', '17.0.0:scope:[r]'], ['17.0.0:scope:[r]']]);
    }
  });
});
