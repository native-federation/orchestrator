import type { SharedExternal, SharedVersion } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { createAcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { type Election, elect } from './election';
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

// `host` ships every member first, as basis precedence lists the host's copy; `chunked` names the builds
// whose files import their own internal chunks.
const electFrom = (
  builds: Build[],
  { host, chunked }: { host?: string; chunked?: string[] } = {}
) =>
  elect({
    members: hosted(members(builds), host),
    isChunked: remote => chunked?.includes(remote) ?? false,
    acceptsTag: createAcceptsTag(versionCheck.isCompatible, versionCheck.compare),
    compare: versionCheck.compare,
    latestFirst: false,
  });

const hosted = (pool: PoolMember[], host: string | undefined): PoolMember[] => {
  for (const { external } of pool)
    for (const version of external.versions) version.host = version.remotes[0]!.name === host;
  return pool;
};

// Who the election placed where, read back from its placements.
const inGlobal = (election: Election) =>
  [...election.placements].filter(([, p]) => p.kind === 'global').map(([r]) => r);
const inSubpool = (election: Election, build: string) =>
  [...election.placements]
    .filter(([, p]) => p.kind === 'subpool' && p.owner === build)
    .map(([r]) => r);

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
   * shipped m, k and n together, so it runs its own subpool. Pinned answer by answer: the gap is the first
   * specifier no build ships next to the ones before it.
   */
  it('names the first unwitnessed specifier on a many-entrypoint portfolio', () => {
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
    const election = electFrom(builds);

    expect(inGlobal(election).sort()).toEqual(['akn', 'amk', 'amn', 'w0', 'w1', 'w2', 'w3', 'w4']);
    expect(inSubpool(election, 'x3')).toEqual(['x1', 'x2', 'x3', 'y']);
    expect(election.misses.size).toBe(4);
    // Every prefix up to k is shipped together (amk, with a's entrypoints witnessed at a's tag); n is the gap.
    for (const remote of ['x1', 'x2', 'x3', 'y'])
      expect(election.misses.get(remote)).toEqual({
        cause: 'uncovered',
        gap: 'n',
        unshipped: true,
      });
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
    const election = electFrom(builds);

    expect(inGlobal(election).sort()).toEqual(['w0', 'w1']);
    expect(election.misses.get('r')).toEqual({
      cause: 'incompatible',
      member: 'm',
      tag: '1.0.0',
      strict: false,
    });
  });
});

describe('round 1', () => {
  // Neither build serves or agrees with the other, so they tie on every key; a comes first in input order,
  // so only the newer-build tiebreak elects b.
  it('breaks a tie on every key toward the newer build, whatever the input order', () => {
    const family = (tag: string, req: string) => ({
      '@fw/core': { tag, req, specifiers: ['@fw/core'] },
      '@fw/common': { tag, req, specifiers: ['@fw/common'] },
    });
    const election = electFrom([
      { name: 'a', copies: family('17.0.0', '~17.0.0') },
      { name: 'b', copies: family('18.0.0', '~18.0.0') },
    ]);

    expect(election.winner).toBe('b');
    expect(inGlobal(election)).toEqual(['b']);
  });
});

describe('subpool rounds', () => {
  const ship = (name: string, tag: string, req: string): Build => ({
    name,
    copies: {
      m: { tag, req, specifiers: ['m'] },
      n: { tag, req, specifiers: ['n'] },
    },
  });

  /**
   * Every remote below rejects round 1's 3.0.0. x's build serves x, a and b (3); y's serves y and a (2); b's
   * serves b and a; a's only itself. x forms the first subpool and takes a and b with it, which leaves y
   * serving only itself: y runs its own build, not a subpool claiming a again. Shrunk by hand from the
   * property counterexample of a formSubpools cache that was not narrowed to the remotes still waiting
   * (C4, e2979f7); that mutant put a in both subpools, and the later one won.
   */
  it('takes a remote into one subpool only: a build it no longer waits for serves only itself', () => {
    const election = electFrom([
      ...[0, 1, 2, 3, 4].map(i => ship(`w${i}`, '3.0.0', '^3.0.0')),
      ship('a', '1.0.0', '^1.0.0'),
      ship('b', '1.0.9', '~1.0.9 || ~1.1.0'),
      ship('x', '1.1.0', '~1.1.0'),
      ship('y', '1.5.0', '~1.5.0'),
    ]);

    expect(inGlobal(election)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4']);
    expect(inSubpool(election, 'x')).toEqual(['a', 'b', 'x']);
    expect(inSubpool(election, 'y')).toEqual([]);
    expect(election.placements.get('y')).toEqual({ kind: 'self', cause: 'incompatible' });
  });

  /**
   * w wins round 1 and borrows p/a@1.0.1 from l and g, which agree with it. g is served, so a global remote
   * already publishes p/a and l is no lender: l (x uncovered) may join b's subpool though b disagrees with
   * the global tags (q@1.0.1). Only a loan no round-1 remote ships keeps its lender out of such a subpool
   * (docs/version-resolver.md §"How pooling resolves", step 2). Counting l as a lender anyway keeps l out of
   * b's subpool; l then adds x to the global tags and goes global, and b is left serving itself. Shrunk from a
   * fuzz counterexample.
   */
  it('lets a remote whose loan a global remote already ships join a subpool whose build disagrees', () => {
    const at = (tag: string, req: string, ...specifiers: string[]) => ({ tag, req, specifiers });
    const election = electFrom([
      { name: 'w', copies: { p: at('1.0.1', '1.0.1', 'p/b'), q: at('1.0.0', '1.0.0', 'q/a') } },
      {
        name: 'b',
        copies: {
          p: at('1.0.1', '^1.0.0', 'p/a'),
          q: at('1.0.1', '^1.0.0', 'q'),
          x: at('1.0.0', '^1.0.0', 'x'),
        },
      },
      { name: 'l', copies: { p: at('1.0.1', '^1.0.0', 'p/a'), x: at('1.0.0', '^1.0.0', 'x') } },
      { name: 'g', copies: { p: at('1.0.1', '^1.0.0', 'p/a'), q: at('1.0.0', '^1.0.0', 'q/a') } },
    ]);

    expect(inGlobal(election)).toEqual(['w', 'g']);
    expect(inSubpool(election, 'b')).toEqual(['b', 'l']);
  });
});

describe('chunked copies', () => {
  const at = (tag: string, ...specifiers: string[]) => ({ tag, req: `^${tag}`, specifiers });

  /**
   * The host ships core alone; x and y ship mat at one tag but each with an entrypoint the other lacks. Round
   * 1 serves neither, and both agree with the host, so extension publishes mat. From flat builds it publishes
   * the union. A chunked file imports its own build's mat internals, so mat/a from x beside mat/b from y would
   * run two of them: mat is not extended, and x and y serve themselves.
   */
  it('extends a package that builds ship with different entrypoints only when none of them is chunked', () => {
    const builds: Build[] = [
      { name: 'host', copies: { core: at('1.0.0', 'core') } },
      { name: 'x', copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/a') } },
      { name: 'y', copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/b') } },
    ];

    const flat = electFrom(builds, { host: 'host' });
    expect([...flat.globalTags]).toEqual([
      ['core', '1.0.0'],
      ['mat', '2.0.0'],
      ['mat/a', '2.0.0'],
      ['mat/b', '2.0.0'],
    ]);
    expect(inGlobal(flat)).toEqual(['host', 'x', 'y']);

    for (const chunked of [['x'], ['y'], ['x', 'y']]) {
      const election = electFrom(builds, { host: 'host', chunked });
      expect([...election.globalTags]).toEqual([['core', '1.0.0']]);
      expect(inGlobal(election)).toEqual(['host']);
      expect(election.placements.get('x')).toEqual({ kind: 'self', cause: 'uncovered' });
      expect(election.placements.get('y')).toEqual({ kind: 'self', cause: 'uncovered' });
    }
  });

  // The same entrypoints from every contributor: whichever build's files the map takes, each runs beside its
  // own build's, so chunked copies still extend.
  it('extends a package that chunked builds ship with the same entrypoints', () => {
    const election = electFrom(
      [
        { name: 'host', copies: { core: at('1.0.0', 'core') } },
        { name: 'x', copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/a') } },
        { name: 'y', copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/a') } },
      ],
      { host: 'host', chunked: ['x', 'y'] }
    );

    expect([...election.globalTags]).toEqual([
      ['core', '1.0.0'],
      ['mat', '2.0.0'],
      ['mat/a', '2.0.0'],
    ]);
    expect(inGlobal(election).sort()).toEqual(['host', 'x', 'y']);
  });

  // As above, but x and y ship mat flat: `mat` and `mat/a` are members of their own, and the map claims each
  // member's row on its own, in record order, so `mat` could come from x and `mat/a` from y. Whatever the
  // order, mat is not extended; flat, it would be.
  it('extends a package flat chunked builds ship with the same entrypoints only from one of them', () => {
    const flat = (name: string): Build => ({
      name,
      copies: {
        core: at('1.0.0', 'core'),
        mat: at('2.0.0', 'mat'),
        'mat/a': at('2.0.0', 'mat/a'),
      },
    });
    const host: Build = { name: 'host', copies: { core: at('1.0.0', 'core') } };

    for (const builds of [
      [host, flat('x'), flat('y')],
      [host, flat('y'), flat('x')],
    ]) {
      const election = electFrom(builds, { host: 'host', chunked: ['x', 'y'] });
      expect([...election.globalTags]).toEqual([['core', '1.0.0']]);
      // One build serves both off the map instead.
      expect(inGlobal(election)).toEqual(['host']);
      expect(election.placements.get('x')).toMatchObject({ kind: 'subpool' });
      expect(election.placements.get('y')).toEqual(election.placements.get('x'));
      expect([...electFrom(builds, { host: 'host' }).globalTags]).toEqual([
        ['core', '1.0.0'],
        ['mat', '2.0.0'],
        ['mat/a', '2.0.0'],
      ]);
    }
    // One flat chunked contributor publishes every row itself.
    expect([...electFrom([host, flat('x')], { host: 'host', chunked: ['x'] }).globalTags]).toEqual([
      ['core', '1.0.0'],
      ['mat', '2.0.0'],
      ['mat/a', '2.0.0'],
    ]);
  });

  /**
   * The host ships core alone; l ships core with rxjs-interop at the host's tag. A flat lender's rxjs-interop
   * binds core through the map, so round 1 borrows it and serves l. A chunked lender's imports its own core
   * internals, which beside the host's core run a second core: it lends nothing, and l serves itself.
   */
  it("borrows an entrypoint from a flat build only, never a chunked build's", () => {
    const builds: Build[] = [
      { name: 'host', copies: { core: at('1.0.0', 'core') } },
      { name: 'l', copies: { core: at('1.0.0', 'core', 'core/rxjs-interop') } },
    ];

    const flat = electFrom(builds, { host: 'host' });
    expect([...flat.globalTags]).toEqual([
      ['core', '1.0.0'],
      ['core/rxjs-interop', '1.0.0'],
    ]);
    expect(inGlobal(flat)).toEqual(['host', 'l']);

    const chunked = electFrom(builds, { host: 'host', chunked: ['l'] });
    expect([...chunked.globalTags]).toEqual([['core', '1.0.0']]);
    expect(inGlobal(chunked)).toEqual(['host']);
    expect(chunked.placements.get('l')).toEqual({ kind: 'self', cause: 'uncovered' });
  });
});
