import type { SharedExternal, SharedVersion } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { createAcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { type Election, elect } from './election';
import type { PoolMember } from './membership';
import { packageOfIn } from 'lib/core/1.domain/externals/specifier';

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

// `host` ships every member first, as basis precedence lists the host's copy.
const electFrom = (builds: Build[], { host }: { host?: string } = {}) =>
  elect({
    members: hosted(members(builds), host),
    packageOf: packageOfIn({}),
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
   * property counterexample of a formSubpools cache that was not narrowed to the remotes still waiting;
   * that mutant put a in both subpools, and the later one won.
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
});

describe('a tie cycle', () => {
  /**
   * a, b and c tie on every key: each serves itself and f, nobody else agrees with them. Only `newer` and the
   * name are left, and they form a cycle: c beats a on p's tag, while b shares no member at another tag with
   * either, so the name puts a before b and b before c. Sorting such a cycle elects whoever the input order
   * favours; found by the init property's "order independence" (POOLING_PROPERTY_SEED=202, SCALE=4).
   */
  const q = { q: { tag: '1.0.0', req: '1.0.0', specifiers: ['q'] } };
  const cycle: Build[] = [
    { name: 'a', copies: { p: { tag: '1.0.0', req: '1.0.0', specifiers: ['p'] }, ...q } },
    { name: 'b', copies: { 'p/x': { tag: '3.0.0', req: '3.0.0', specifiers: ['p/x'] }, ...q } },
    { name: 'c', copies: { p: { tag: '2.0.0', req: '2.0.0', specifiers: ['p'] }, ...q } },
    { name: 'f', copies: { q: { tag: '1.0.0', req: '^1.0.0', specifiers: ['q'] } } },
  ];
  const recordOrders = (builds: Build[]): Build[][] =>
    builds.length <= 1
      ? [builds]
      : builds.flatMap((build, i) =>
          recordOrders(builds.filter((_, j) => j !== i)).map(rest => [build, ...rest])
        );

  // Which of a, b and c wins is arbitrary within the cycle; that it is the same one in every order is not.
  it('elects one round-1 winner in every record order', () => {
    const winners = recordOrders(cycle).map(builds => electFrom(builds).winner);

    expect(new Set(winners)).toEqual(new Set([winners[0]]));
  });

  // w0-w4 win round 1 at q@9.0.0, which no build of the cycle accepts, so the cycle meets again for
  // f's subpool.
  it('gives f one subpool owner in every record order', () => {
    const winners = Array.from({ length: 5 }, (_, i): Build => ({
      name: `w${i}`,
      copies: { q: { tag: '9.0.0', req: '^9.0.0', specifiers: ['q'] } },
    }));
    const owners = recordOrders(cycle).map(builds => {
      const placement = electFrom([...winners, ...builds]).placements.get('f');
      return placement?.kind === 'subpool' ? placement.owner : placement?.kind;
    });

    expect(new Set(owners)).toEqual(new Set([owners[0]]));
    expect(['a', 'b', 'c']).toContain(owners[0]);
  });
});

describe('entrypoints across builds', () => {
  const at = (tag: string, ...specifiers: string[]) => ({ tag, req: `^${tag}`, specifiers });

  /**
   * The host ships core alone; x and y ship mat at one tag but each with an entrypoint the other lacks. Round
   * 1 serves neither, and both agree with the host, so extension publishes mat — from one build only, so
   * every specifier of mat runs from the build that shipped it. Neither copy contains the other, so the name
   * picks x; y serves itself.
   */
  it('extends a package that builds ship with different entrypoints from one of them', () => {
    const builds: Build[] = [
      { name: 'host', copies: { core: at('1.0.0', 'core') } },
      { name: 'y', copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/b') } },
      { name: 'x', copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/a') } },
    ];

    const election = electFrom(builds, { host: 'host' });
    expect([...election.globalTags]).toEqual([
      ['core', '1.0.0'],
      ['mat', '2.0.0'],
      ['mat/a', '2.0.0'],
    ]);
    expect(inGlobal(election)).toEqual(['host', 'x']);
    expect(election.placements.get('y')).toEqual({ kind: 'self', cause: 'uncovered' });
  });

  // The copy that contains the most others is published, so every remote whose copy it contains runs on it.
  it('extends a package from the copy that contains the most others', () => {
    const builds: Build[] = [
      { name: 'host', copies: { core: at('1.0.0', 'core') } },
      {
        name: 'a',
        copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/a', 'mat/z') },
      },
      {
        name: 'w',
        copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/a', 'mat/b') },
      },
      { name: 'x', copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/a') } },
      { name: 'y', copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/b') } },
    ];

    const election = electFrom(builds, { host: 'host' });

    expect([...election.globalTags]).toEqual([
      ['core', '1.0.0'],
      ['mat', '2.0.0'],
      ['mat/a', '2.0.0'],
      ['mat/b', '2.0.0'],
    ]);
    expect(inGlobal(election).sort()).toEqual(['host', 'w', 'x', 'y']);
    expect(election.placements.get('a')).toEqual({ kind: 'self', cause: 'uncovered' });
  });

  // The same entrypoints from every contributor: whichever build's files the map takes, each remote runs
  // every specifier of mat from it.
  it('extends a package that builds ship with the same entrypoints', () => {
    const election = electFrom(
      [
        { name: 'host', copies: { core: at('1.0.0', 'core') } },
        { name: 'x', copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/a') } },
        { name: 'y', copies: { core: at('1.0.0', 'core'), mat: at('2.0.0', 'mat', 'mat/a') } },
      ],
      { host: 'host' }
    );

    expect([...election.globalTags]).toEqual([
      ['core', '1.0.0'],
      ['mat', '2.0.0'],
      ['mat/a', '2.0.0'],
    ]);
    expect(inGlobal(election).sort()).toEqual(['host', 'x', 'y']);
  });

  // As above, but x and y ship mat flat: `mat` and `mat/a` are members of their own. Both ship the same
  // entrypoints, so whichever build's copy the map takes, each runs every specifier of mat from it.
  it('extends a package flat builds ship with the same entrypoints', () => {
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
      const election = electFrom(builds, { host: 'host' });
      expect([...election.globalTags]).toEqual([
        ['core', '1.0.0'],
        ['mat', '2.0.0'],
        ['mat/a', '2.0.0'],
      ]);
      expect(inGlobal(election).sort()).toEqual(['host', 'x', 'y']);
    }
  });

  /**
   * The host ships core alone; l ships core with rxjs-interop at the host's tag. Round 1 serves a build on
   * its own tags, so the host borrows no entrypoint from another build: l serves itself.
   */
  it('borrows no entrypoint from another build of the same tag', () => {
    const builds: Build[] = [
      { name: 'host', copies: { core: at('1.0.0', 'core') } },
      { name: 'l', copies: { core: at('1.0.0', 'core', 'core/rxjs-interop') } },
    ];

    const election = electFrom(builds, { host: 'host' });
    expect([...election.globalTags]).toEqual([['core', '1.0.0']]);
    expect(inGlobal(election)).toEqual(['host']);
    expect(election.placements.get('l')).toEqual({ kind: 'self', cause: 'uncovered' });
  });
});

/**
 * The host wins round 1 with core and q at 1.0.0. o's `~1.1.0` rejects it, so o's build serves o and the
 * remotes that ship el, which the host lacks, as a subpool. Those remotes agree with the host on everything
 * both ship, so once the host's map fills el from them they run on the host's build instead.
 */
describe('host fill', () => {
  const at = (tag: string, req: string, ...specifiers: string[]) => ({ tag, req, specifiers });
  const family = (name: string): Build => ({
    name,
    copies: { core: at('1.0.0', '~1.0.0', 'core'), q: at('1.0.0', '~1.0.0', 'q') },
  });
  const host = family('host');
  const o = (el: string, ...entrypoints: string[]): Build => ({
    name: 'o',
    copies: { core: at('1.1.0', '~1.1.0', 'core'), el: at(el, `^${el}`, 'el', ...entrypoints) },
  });
  const agreeing = (name: string, el: Build['copies'][string]): Build => ({
    name,
    copies: { core: at('1.0.0', '^1.0.0', 'core'), el },
  });
  const HOST_TAGS = [
    ['core', '1.0.0'],
    ['q', '1.0.0'],
  ];

  // o ships el too, at another tag, but it disagrees with the host, so it offers nothing.
  it('fills a package from a subpool member that agrees with the host, which then runs on it', () => {
    const election = electFrom([host, o('1.0.1'), agreeing('r', at('1.0.0', '^1.0.0', 'el'))], {
      host: 'host',
    });

    expect([...election.globalTags]).toEqual([...HOST_TAGS, ['el', '1.0.0']]);
    expect(inGlobal(election)).toEqual(['host', 'r']);
    expect(election.placements.get('o')).toEqual({ kind: 'self', cause: 'incompatible' });
  });

  // w1 and w2 make the host's build win round 1 on its own, so the same build wins without the host flag.
  it('fills nothing when the winner is no host', () => {
    const builds = [
      host,
      family('w1'),
      family('w2'),
      o('1.0.0'),
      agreeing('r', at('1.0.0', '^1.0.0', 'el')),
    ];

    expect(inGlobal(electFrom(builds, { host: 'host' }))).toEqual(['host', 'w1', 'w2', 'r']);
    const election = electFrom(builds);
    expect(election.winner).toBe('host');
    expect([...election.globalTags]).toEqual(HOST_TAGS);
    expect(inGlobal(election)).toEqual(['host', 'w1', 'w2']);
    expect(inSubpool(election, 'o')).toEqual(['r', 'o']);
  });

  it('fills nothing from members that ship the package at two tags', () => {
    const election = electFrom(
      [
        host,
        o('1.0.1'),
        agreeing('r1', at('1.0.0', '^1.0.0', 'el')),
        agreeing('r2', at('1.0.1', '^1.0.0', 'el')),
      ],
      { host: 'host' }
    );

    expect([...election.globalTags]).toEqual(HOST_TAGS);
    expect(inSubpool(election, 'o')).toEqual(['r1', 'r2', 'o']);
  });

  // g serves itself and runs globally, so it contributes el first; r's other tag would null the offer if it
  // counted. r's exact range rejects g's el, so it stays in o's subpool.
  it("publishes a globally running contributor's tag over a fill member's", () => {
    const election = electFrom(
      [
        host,
        o('1.0.0'),
        agreeing('r', at('1.0.0', '1.0.0', 'el')),
        agreeing('g', at('1.0.1', '^1.0.1', 'el')),
      ],
      { host: 'host' }
    );

    expect([...election.globalTags]).toEqual([...HOST_TAGS, ['el', '1.0.1']]);
    expect(inGlobal(election)).toEqual(['host', 'g']);
    expect(inSubpool(election, 'o')).toEqual(['r', 'o']);
  });

  // r's el sits at another tag than g's, and a contributor ships el, so r's wider copy never competes for
  // it: g's is published, and r lacks el/x on the map and stays in o's subpool.
  it("publishes a contributor's copy over a wider fill copy at another tag", () => {
    const election = electFrom(
      [
        host,
        o('1.0.1', 'el/x'),
        agreeing('r', at('1.0.1', '^1.0.0', 'el', 'el/x')),
        agreeing('g', at('1.0.0', '1.0.0', 'el')),
      ],
      { host: 'host' }
    );

    expect([...election.globalTags]).toEqual([...HOST_TAGS, ['el', '1.0.0']]);
    expect(inGlobal(election)).toEqual(['host', 'g']);
    expect(inSubpool(election, 'o')).toEqual(['r', 'o']);
  });

  // As for contributors, one member's copy is published: neither contains the other, so the name picks r1, and
  // r2 stays in o's subpool.
  it('fills a package members ship with different entrypoints from one of them', () => {
    const builds = [
      host,
      o('1.0.0', 'el/a', 'el/b'),
      agreeing('r2', at('1.0.0', '^1.0.0', 'el', 'el/b')),
      agreeing('r1', at('1.0.0', '^1.0.0', 'el', 'el/a')),
    ];

    const election = electFrom(builds, { host: 'host' });
    expect([...election.globalTags]).toEqual([...HOST_TAGS, ['el', '1.0.0'], ['el/a', '1.0.0']]);
    expect(inGlobal(election)).toEqual(['host', 'r1']);
    expect(inSubpool(election, 'o')).toEqual(['r2', 'o']);
  });

  /**
   * c serves itself and contributes mat with mat/a; r, in o's subpool, ships mat alone at the same tag. A
   * contributor ships mat, so no fill member is asked; r's copy is contained in c's, so r goes global and
   * runs c's mat.
   */
  it("moves a fill member onto a contributor's copy that contains its own", () => {
    const mat = (...specifiers: string[]) => at('2.0.0', '^2.0.0', ...specifiers);
    const remotes: Record<string, Build> = {
      o: { name: 'o', copies: { core: at('1.1.0', '^1.1.0', 'core'), mat: mat('mat') } },
      r: { name: 'r', copies: { core: at('1.0.0', '^1.0.0', 'core'), mat: mat('mat') } },
      c: { name: 'c', copies: { core: at('1.0.0', '^1.0.0', 'core'), mat: mat('mat', 'mat/a') } },
    };

    for (const order of [
      ['o', 'r', 'c'],
      ['c', 'o', 'r'],
      ['r', 'c', 'o'],
    ]) {
      const builds = [host, family('w1'), family('w2'), ...order.map(n => remotes[n]!)];
      const election = electFrom(builds, { host: 'host' });
      expect([...election.globalTags]).toEqual([
        ...HOST_TAGS,
        ['mat', '2.0.0'],
        ['mat/a', '2.0.0'],
      ]);
      expect(inGlobal(election).sort()).toEqual(['c', 'host', 'r', 'w1', 'w2']);
      expect(election.placements.get('o')).toEqual({ kind: 'self', cause: 'incompatible' });
    }
  });
});
