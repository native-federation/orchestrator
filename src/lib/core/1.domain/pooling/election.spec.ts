import type { SharedExternal, SharedVersion } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { acceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { electVariants } from './election';
import type { PoolMember } from './membership';

const versionCheck = createVersionCheck();

// One remote's build: per member, the tag it ships, its range and the specifiers it carries.
type Build = {
  name: string;
  copies: Record<string, { tag: string; req: string; specifiers: string[]; strict?: boolean }>;
};

const members = (builds: Build[]): PoolMember[] => {
  const byMember = new Map<string, Map<string, Build[]>>();
  for (const build of builds)
    for (const [name, { tag }] of Object.entries(build.copies)) {
      const tags = byMember.get(name) ?? byMember.set(name, new Map()).get(name)!;
      (tags.get(tag) ?? tags.set(tag, []).get(tag)!).push(build);
    }
  return [...byMember].map(([name, tags]) => ({
    name,
    external: {
      dirty: true,
      versions: [...tags].map<SharedVersion>(([tag, owners]) => ({
        tag,
        host: false,
        action: 'skip',
        remotes: owners.map(owner =>
          mockVersionRemote(owner.name, name, {
            requiredVersion: owner.copies[name]!.req,
            strictVersion: owner.copies[name]!.strict,
            entries: Object.fromEntries(owner.copies[name]!.specifiers.map(s => [s, `${s}.js`])),
          })
        ),
      })),
    } satisfies SharedExternal,
  }));
};

const elect = (builds: Build[]) =>
  electVariants({
    members: members(builds),
    acceptsTag: acceptsTag(versionCheck.isCompatible, versionCheck.compare),
    hosts: new Set(),
    arrival: new Map(builds.map((b, i) => [b.name, i])),
    compare: versionCheck.compare,
    latestFirst: false,
  });

describe('missOf', () => {
  const entrypoints = (pkg: string, count: number) => [
    pkg,
    ...Array.from({ length: count }, (_, i) => `${pkg}/e${String(i).padStart(2, '0')}`),
  ];

  const ship = (name: string, copies: Record<string, string[]>): Build => ({
    name,
    copies: Object.fromEntries(
      Object.entries(copies).map(([m, specifiers]) => [
        m,
        { tag: '1.0.0', req: '~1.0.0', specifiers },
      ])
    ),
  });
  const drifted = (name: string, tag: string, copies: Record<string, string[]>): Build => ({
    name,
    copies: Object.fromEntries(
      Object.entries(copies).map(([m, specifiers]) => [m, { tag, req: '^1.0.0', specifiers }])
    ),
  });

  /**
   * The witness case (a coverage no single build shipped), with many entrypoints: round 1 elects a's
   * 1.0.0 build with 40 entrypoints, and three 1.0.0 builds ship m, k and n pairwise next to bare `a`. Each
   * drifted remote ships a, its entrypoints, m, k and n at 1.1.x and accepts every 1.0.0 tag, but no build
   * shipped m, k and n together, so it runs its own subpool. Pinned answer by answer because the search for
   * the gap and the smallest clashing set was rewritten from repeated `shippedTogether` calls to one match
   * row per build; the old and new code give this exact output.
   */
  it('names the first unwitnessed specifier and a smallest clash on a many-entrypoint portfolio', () => {
    const full = entrypoints('a', 40);
    const builds: Build[] = [
      ...[0, 1, 2, 3, 4].map(i => ship(`w${i}`, { a: full })),
      ship('amk', { a: ['a'], m: ['m'], k: ['k'] }),
      ship('amn', { a: ['a'], m: ['m'], n: ['n'] }),
      ship('akn', { a: ['a'], k: ['k'], n: ['n'] }),
      ...[1, 2, 3].map(i =>
        drifted(`x${i}`, `1.1.${i}`, { a: full, m: ['m'], k: ['k'], n: ['n'] })
      ),
      drifted('y', '1.1.9', { a: full.slice(30), k: ['k'], n: ['n'], m: ['m'] }),
    ];
    const election = elect(builds);

    expect([...election.global].sort()).toEqual([
      'akn',
      'amk',
      'amn',
      'w0',
      'w1',
      'w2',
      'w3',
      'w4',
    ]);
    expect(election.subpools).toEqual([{ build: 'x3', members: ['x1', 'x2', 'x3', 'y'] }]);
    // Every prefix up to k is shipped together (amk, with a's entrypoints witnessed at a's tag); n is the gap.
    // amn and akn each ship n next to one of m and k, so the smallest clash is both, and none of a's.
    for (const remote of ['x1', 'x2', 'x3', 'y'])
      expect(election.missOf(remote)).toEqual({ unwitnessed: { gap: 'n', with: ['m', 'k'] } });
  });

  // r rejects both members' elected tag, neither strictly: the miss names the first member r ships, so
  // the warning reads the same whichever rejection a scan meets last.
  it('names the first of two non-strict rejections', () => {
    const at1 = (strict: boolean) => ({ tag: '1.0.0', req: '~1.0.0', specifiers: [], strict });
    const builds: Build[] = [
      ...['w0', 'w1'].map(name => ({
        name,
        copies: {
          m: { ...at1(true), specifiers: ['m'] },
          n: { ...at1(true), specifiers: ['n'] },
        },
      })),
      {
        name: 'r',
        copies: {
          m: { tag: '2.0.0', req: '^2.0.0', specifiers: ['m'], strict: false },
          n: { tag: '2.0.0', req: '^2.0.0', specifiers: ['n'], strict: false },
        },
      },
    ];
    const election = elect(builds);

    expect([...election.global].sort()).toEqual(['w0', 'w1']);
    expect(election.missOf('r')).toEqual({
      rejected: { member: 'm', tag: '1.0.0', strict: false },
    });
  });

  // A dense build may list one specifier under two members: here `k` under both k and kk. The clash search
  // drops a specifier by value, so both listings of `k` stay or go together. Dropping by index kept only the
  // second listing and answered ['m', 'k']; the search this replaced answered ['m', 'k', 'k'] as here.
  it('keeps or drops a specifier two members list as one', () => {
    const full = entrypoints('a', 40);
    const builds: Build[] = [
      ...[0, 1, 2, 3, 4].map(i => ship(`w${i}`, { a: full })),
      ship('amk', { a: ['a'], m: ['m'], k: ['k'], kk: ['k'] }),
      ship('amn', { a: ['a'], m: ['m'], n: ['n'] }),
      ship('akn', { a: ['a'], k: ['k'], n: ['n'] }),
      ...[1, 2, 3].map(i =>
        drifted(`x${i}`, `1.1.${i}`, { a: full, m: ['m'], k: ['k'], kk: ['k'], n: ['n'] })
      ),
    ];
    const election = elect(builds);

    expect(election.subpools).toEqual([{ build: 'x3', members: ['x1', 'x2', 'x3'] }]);
    for (const remote of ['x1', 'x2', 'x3'])
      expect(election.missOf(remote)).toEqual({ unwitnessed: { gap: 'n', with: ['m', 'k', 'k'] } });
  });
});

describe('reading a build from the record', () => {
  const at = (tag: string, req: string, specifiers: string[]) => ({ tag, req, specifiers });

  // A record the orchestrator never writes itself: b lists `x` twice, and only the second row carries
  // `x/extra`. A build ships one copy per member, so the first row is taken whole, entries included.
  it('reads a duplicated row as the first one, entries included', () => {
    const row = (tag: string, entries: string[]) => ({
      tag,
      host: false,
      action: 'skip' as const,
      remotes: [
        mockVersionRemote('b', 'x', {
          requiredVersion: '~1.0.0',
          entries: Object.fromEntries(entries.map(s => [s, `${s}-${tag}.js`])),
        }),
      ],
    });
    const election = electVariants({
      members: [
        {
          name: 'x',
          external: {
            dirty: true,
            versions: [row('1.0.1', ['x']), row('1.0.0', ['x', 'x/extra'])],
          },
        },
      ],
      acceptsTag: acceptsTag(versionCheck.isCompatible, versionCheck.compare),
      hosts: new Set(),
      arrival: new Map([['b', 0]]),
      compare: versionCheck.compare,
      latestFirst: false,
    });

    expect(election.winner).toBe('b');
    expect([...election.coverage]).toEqual([['x', '1.0.1']]);
  });

  // Flat and dense in one build: `x/sub` is an entry of R's dense `x` at 1.0.0 and R's own flat package at
  // 2.0.0. The build's tag for it is the first copy's in pool order, which the members helper takes from the
  // order the copies are listed in.
  it.each([
    [
      'dense first',
      { x: at('1.0.0', '^1.0.0', ['x', 'x/sub']), 'x/sub': at('2.0.0', '^2.0.0', ['x/sub']) },
      '1.0.0',
    ],
    [
      'flat first',
      { 'x/sub': at('2.0.0', '^2.0.0', ['x/sub']), x: at('1.0.0', '^1.0.0', ['x', 'x/sub']) },
      '2.0.0',
    ],
  ])('takes a specifier two members list from the first in pool order (%s)', (_, copies, tag) => {
    const election = elect([{ name: 'r', copies }]);

    expect(election.winner).toBe('r');
    expect(election.coverage.get('x/sub')).toBe(tag);
  });
});
