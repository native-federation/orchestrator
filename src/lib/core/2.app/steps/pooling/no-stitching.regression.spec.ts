import type { DenseSharedInfo, ImportMap, RemoteEntry } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';
import { importsFrom, pageFaults, resolve, type PageFaults } from 'lib/testing/pooling/page-graph';

/**
 * One build per package: for each remote, every specifier of one package resolves to files of one build. Each
 * case runs the init (or dynamic) flow end to end and judges the map with the page-wide oracle: every remote
 * imports all it ships, and each file's imports resolve through the scopes matching that file's own URL
 * (closest referrer), not the remote that started the chain.
 *
 * A case that still fails carries `known`, the oracle's verdict on today's map: the target spec is registered
 * as `it.fails` and a sibling spec pins `known`, so a crash or a different failure turns red. A case without
 * `known` runs the target spec for real.
 * The harness's own no-tear oracle is off: it compares tags only, so it passes every case here.
 */

const CORE = '@fw/core';
const INTEROP = '@fw/core/interop';
const TESTING = '@fw/core/testing';
const SUB = '@fw/core/sub';
const A = '@fw/core/a';
const B = '@fw/core/b';
const FORMS = '@fw/forms';
const RXJS = 'rxjs';

type SharedOpts = {
  entrypoints?: string[];
  chunked?: boolean;
  version?: string;
  range?: string;
  strict?: boolean;
  pool?: string | false;
  shareScope?: string;
};

const file = (s: string) => `${s.replace(/^@/, '').replace(/\//g, '_')}.js`;

// One package at 17.0.0 (`~17.0.0`) in the `fw` pool unless `pool: false`; `chunked` puts its files in one
// dense bundle with one internal chunk.
const shared = (packageName: string, opts: SharedOpts = {}): DenseSharedInfo =>
  ({
    packageName,
    version: opts.version ?? '17.0.0',
    requiredVersion: opts.range ?? '~17.0.0',
    singleton: true,
    strictVersion: opts.strict ?? false,
    ...(opts.pool === false ? {} : { pool: opts.pool ?? 'fw' }),
    ...(opts.shareScope ? { shareScope: opts.shareScope } : {}),
    ...(opts.chunked ? { bundle: `browser-${file(packageName).slice(0, -3)}` } : {}),
    entries: Object.fromEntries([packageName, ...(opts.entrypoints ?? [])].map(s => [s, file(s)])),
  }) as DenseSharedInfo;

// A flat-chunking build's internals, as the `@nf-internal/` external it ships.
const flatChunk = (remote: string): DenseSharedInfo =>
  ({
    packageName: `@nf-internal/chunk-${remote}`,
    version: '0.0.0',
    requiredVersion: '0.0.0',
    singleton: false,
    strictVersion: false,
    entries: { [`@nf-internal/chunk-${remote}`]: `chunk-${remote}.js` },
  }) as DenseSharedInfo;

const at = (version: string) => ({ version, range: `~${version}` });

// Names stay lower case: they become URL hosts, which a browser lowercases.
const entry = (name: string, ...sharedInfo: DenseSharedInfo[]): RemoteEntry => {
  const bundles = sharedInfo.flatMap(i => (i.bundle ? [i.bundle] : []));
  return {
    name,
    url: `http://${name}/remoteEntry.json`,
    exposes: [],
    shared: sharedInfo,
    ...(bundles.length > 0
      ? { chunks: Object.fromEntries(bundles.map(b => [b, [`chunk-${b}.js`]])) }
      : {}),
  } as unknown as RemoteEntry;
};

type Case = {
  name: string;
  entries: RemoteEntry[];
  dynamic?: RemoteEntry[];
  // After the loads, a new page runs a warm init over the stored record; that page's map is judged.
  reload?: boolean;
  // `strict.strictExternalCompatibility`.
  strict?: boolean;
  hosts?: string[];
  scope?: string;
  // What a file imports beyond its own package's entrypoints and chunks.
  deps?: Record<string, string[]>;
  // The case's own expectations on the fixed map, beyond the oracle verdict.
  expectMap?: (map: ImportMap) => void;
  // The oracle's verdict on the fixed map, when a fault is the intended outcome.
  expectFaults?: Record<string, PageFaults>;
  // While the case still fails: the oracle's verdict on today's map.
  known?: Record<string, PageFaults>;
};

let storage = 0;
const run = async (c: Case) => {
  const p = portfolio(
    {},
    {
      storage: `nf-no-stitching-${storage++}`,
      realRepositories: true,
      assertNoTear: false,
      hosts: c.hosts ?? [],
      strict: c.strict,
      ...(c.scope && { scope: c.scope }),
    }
  );
  let map: ImportMap = await p.runInit(c.entries);
  // Per load, the `imports` keys its delta re-declares: a browser rejects each one.
  const remapped: string[][] = [];
  for (const d of c.dynamic ?? []) {
    const { committed, importMap, merged } = await p.runDynamic(d);
    remapped.push(Object.keys(importMap.imports).filter(key => key in committed.imports));
    map = merged;
  }
  if (c.reload) {
    p.reload();
    map = await p.runInit();
  }
  const faults = pageFaults({
    importMap: map,
    entries: [...c.entries, ...(c.dynamic ?? [])],
    hosts: c.hosts,
    importsOf: importsFrom(c.deps ?? {}),
  });
  return { map, faults, remapped };
};

const register = (c: Case) => {
  (c.known ? it.fails : it)(c.name, async () => {
    const { map, faults, remapped } = await run(c);
    expect(faults).toEqual(c.expectFaults ?? {});
    expect(remapped).toEqual((c.dynamic ?? []).map(() => []));
    c.expectMap?.(map);
  });
  if (c.known) {
    const known = c.known;
    const kinds = [...new Set(Object.values(known).flatMap(Object.keys))].sort().join(', ');
    it(`${c.name}: today ${kinds}`, async () => {
      const { faults } = await run(c);
      expect(faults).toEqual(known);
    });
  }
};

const pools = ['fw', false] as const;

describe('a remote runs every specifier of a package from one build', () => {
  const cases: Case[] = [
    // Unpooled. The host's core leads the 17.0.0 row; b's copy adds interop, whose file imports b's chunk. The
    // host's build lacks interop, so b runs core from its own build, chunk included.
    {
      name: 'serves no chunked entrypoint beside another copy of its version (unpooled)',
      hosts: ['a'],
      entries: [
        entry('b', shared(CORE, { pool: false, chunked: true, entrypoints: [INTEROP] })),
        entry(
          'a',
          shared(CORE, { pool: false, chunked: true }),
          shared(FORMS, { pool: false, chunked: true })
        ),
      ],
    },
    // Pooled: the host pins core in round 1 and lacks interop, so mfe runs core from its own build, its chunked
    // interop included.
    {
      name: 'serves no chunked entrypoint beside the pinned host core',
      hosts: ['host'],
      entries: [
        entry('mfe', shared(CORE, { chunked: true, entrypoints: [INTEROP] })),
        entry('host', shared(CORE, { chunked: true })),
      ],
    },
    // u and chunked c ship interop at the host's core tag. Round 1 borrows nothing for the host, so the map
    // never publishes c's interop, which would bind c's core internals beside the host's core.
    {
      name: "serves no chunked copy's entrypoint beside the host's core",
      hosts: ['host'],
      entries: [
        entry(
          'c',
          shared(CORE, { chunked: true, entrypoints: [INTEROP] }),
          shared(FORMS, { chunked: true })
        ),
        entry('u', shared(CORE, { entrypoints: [INTEROP] }), shared(FORMS)),
        entry('host', shared(CORE), shared(FORMS)),
      ],
      expectMap: map => expect(map.imports[INTEROP]).not.toBe('http://c/fw_core_interop.js'),
    },
    // r3 wins with core alone; r1 (kept off the map by forms) and chunked r0 ship testing at its tag. Round 1
    // borrows nothing, so the map never publishes r0's testing beside r3's core.
    {
      name: "runs testing from its core's build when only a chunked copy ships it globally",
      entries: [
        entry('r0', shared(CORE, { ...at('17.0.1'), chunked: true, entrypoints: [TESTING] })),
        entry('r1', shared(CORE, { ...at('17.0.1'), entrypoints: [TESTING] }), shared(FORMS)),
        entry('r2', shared(FORMS, at('17.0.1'))),
        entry('r3', shared(CORE, at('17.0.1')), shared('@fw/x')),
      ],
    },
    // mfe2 is dense core@2 listing testing; mfe1 is flat core@1, strict, so it runs its own
    // core, and its own testing external is that package's only share row. Core's row claims the testing
    // specifier first, so mfe1 runs mfe2's testing, which binds core through mfe2's URL: core 1.0.0 with
    // testing 2.0.0. In a named share scope and in the global one.
    ...(['custom', undefined] as const).map((shareScope): Case => {
      const pin = (version: string) => ({
        pool: false as const,
        strict: true,
        shareScope,
        version,
        range: `^${version}`,
      });
      return {
        name: `claims no entrypoint for a remote on its own build (scope=${shareScope ?? 'global'})`,
        scope: shareScope,
        entries: [
          entry('mfe2', shared(CORE, { ...pin('2.0.0'), entrypoints: [TESTING] })),
          entry('mfe1', shared(CORE, pin('1.0.0')), shared(TESTING, pin('1.0.0'))),
        ],
        expectMap: map =>
          expect(resolve(map, TESTING, 'http://mfe1/expose.js')).toBe(
            'http://mfe1/fw_core_testing.js'
          ),
      };
    }),
    // u ships core with interop, unchunked, and scopes rxjs to its own strict 6.6.0; the host
    // h ships core without interop and rxjs 7.8.0. Both files import rxjs, each through its own URL: the host's
    // build lacks interop, so u runs core from its own build, and both of u's files bind rxjs 6.6.0 through u's
    // scope. Without a host the same map leaks the winner's scope, a separate defect that one build per package
    // does not fix, so that variant is not here.
    ...pools.flatMap(pool =>
      [undefined, 'custom'].map((shareScope): Case => ({
        name: `binds no file's imports through another build's scope (pool=${pool}, scope=${shareScope ?? 'global'})`,
        scope: shareScope,
        hosts: ['h'],
        deps: { [INTEROP]: [RXJS], [CORE]: [RXJS] },
        entries: [
          entry(
            'u',
            shared(CORE, { pool, shareScope, entrypoints: [INTEROP] }),
            shared(RXJS, {
              pool: false,
              shareScope,
              version: '6.6.0',
              range: '6.6.0',
              strict: true,
            })
          ),
          entry(
            'h',
            shared(CORE, { pool, shareScope }),
            shared(RXJS, { pool: false, shareScope, version: '7.8.0', range: '^7.0.0' })
          ),
        ],
      }))
    ),
    // No host: chunked dense r0 ships core{core, testing}; chunked flat r1 ships core,
    // testing and forms and wins, yet the core row (r0's) claims testing.
    {
      name: "claims no entrypoint the winner ships itself from another build's row",
      entries: [
        entry('r0', shared(CORE, { chunked: true, entrypoints: [TESTING] })),
        entry(
          'r1',
          shared(CORE, { chunked: true }),
          shared(TESTING, { chunked: true }),
          shared(FORMS, { chunked: true })
        ),
      ],
      expectMap: map => expect(map.imports[TESTING]).toBe('http://r1/fw_core_testing.js'),
    },
    // With a host: the dense chunked host lists testing;
    // flat-chunked r ships it as an external of its own, registered before its core, so r's testing row claims
    // the specifier first.
    ...pools.map((pool): Case => ({
      name: `claims none of the host's own entrypoints from a remote's row (pool=${pool})`,
      hosts: ['host'],
      entries: [
        entry(
          'r',
          shared(TESTING, { pool }),
          shared(CORE, { pool }),
          shared(FORMS, { pool }),
          flatChunk('r')
        ),
        entry('host', shared(CORE, { pool, chunked: true, entrypoints: [TESTING] })),
      ],
      expectMap: map => expect(map.imports[TESTING]).toBe('http://host/fw_core_testing.js'),
    })),
    // b's `core/b` imports `core/a`. The host a ships core and `core/a` but not `core/b`, so b and r each run
    // core from their own build and `core/a` binds their own copy, chunked or not.
    ...[true, false].map((chunked): Case => ({
      name: `runs no entrypoint that imports a sibling another build serves (chunked=${chunked})`,
      hosts: ['a'],
      entries: [
        entry('b', shared(CORE, { chunked, entrypoints: [A, B] })),
        entry('r', shared(CORE, { chunked, entrypoints: [A, B] })),
        entry('a', shared(CORE, { chunked, entrypoints: [A] })),
      ],
    })),
    // b and r ship interop, which the host's core lacks, so each runs core from its own build. Interop imports
    // forms: b's binds b's strict 16.0.0 through b's URL, r's binds the map's forms (17).
    {
      name: "binds no sibling package through the scope of another build's entrypoint",
      hosts: ['a'],
      deps: { [INTEROP]: [FORMS] },
      entries: [
        entry(
          'b',
          shared(CORE, { entrypoints: [INTEROP] }),
          shared(FORMS, { pool: false, version: '16.0.0', range: '16.0.0', strict: true })
        ),
        entry('r', shared(CORE, { entrypoints: [INTEROP] }), shared(FORMS, { pool: false })),
        entry('a', shared(CORE), shared(FORMS, { pool: false })),
      ],
    },
    // Unchunked, so nothing loads twice and the tag oracle passes it: the flat host r0 ships core and core/sub
    // as externals of their own, dense r1 ships core{core, core/sub}. The core row serves r1's sub (the
    // version's union) before r0's own sub row claims it, so both run core from two builds.
    {
      name: 'serves no entrypoint of a package from another build than its root (unchunked)',
      hosts: ['r0'],
      entries: [
        entry('r1', shared(CORE, { entrypoints: [SUB] })),
        entry('r0', shared(CORE), shared(SUB)),
      ],
    },
    // The host wins the pool but ships only core/sub, as a flat external of its own; chunked d and unchunked u
    // ship core{core, core/sub}. The host borrows no root, so d and u run the whole package from d's build in a
    // subpool, and the host its own sub: nobody runs d's core internals beside the host's sub chunk.
    {
      name: "takes a pooled package from its root's build when the winner ships only a flat secondary",
      hosts: ['host'],
      entries: [
        entry('d', shared(CORE, { chunked: true, entrypoints: [SUB] })),
        entry('u', shared(CORE, { entrypoints: [SUB] })),
        entry('host', shared(SUB, { chunked: true })),
      ],
      expectMap: map => {
        expect(map.imports[SUB]).toBe('http://host/fw_core_sub.js');
        expect(map.scopes?.['http://u/']?.[CORE]).toBe('http://d/fw_core.js');
        expect(map.scopes?.['http://u/']?.[SUB]).toBe('http://d/fw_core_sub.js');
      },
    },
    // A remote loaded at runtime ships interop, which the page lacks: it runs core and interop from its own
    // build, with its bundle's chunk mapped in its own scope.
    ...pools.map((pool): Case => ({
      name: `maps the chunks of every entrypoint a dynamic remote runs (pool=${pool})`,
      hosts: ['host'],
      entries: [entry('host', shared(CORE, { pool, chunked: true }))],
      dynamic: [entry('mfe4', shared(CORE, { pool, chunked: true, entrypoints: [INTEROP] }))],
    })),
    // The dense chunked host lists testing; flat r, loaded at runtime, ships strict core@16 and testing@16,
    // which the page serves at 17. r runs both from its own build, in its own scope: the delta maps nothing in
    // `imports`, which a browser would reject for a key the page already maps.
    ...[true, false].map((flatChunks): Case => ({
      name: `remaps no entrypoint the page already maps (flat chunks=${flatChunks})`,
      hosts: ['host'],
      entries: [
        entry('host', shared(CORE, { pool: false, chunked: true, entrypoints: [TESTING] })),
      ],
      dynamic: [
        entry(
          'r',
          shared(TESTING, { pool: false, version: '16.0.0', range: '^16.0.0', strict: true }),
          shared(CORE, { pool: false, version: '16.0.0', range: '^16.0.0', strict: true }),
          ...(flatChunks ? [flatChunk('r')] : [])
        ),
      ],
    })),
    // As above with r's ranges lenient, and with r at the host's own tag: nothing scopes r, so it follows the
    // host for the whole package. Its flat testing has no share row of its own, yet the host's core row
    // already serves it, so the load maps no key of its own.
    ...['16.0.0', '17.0.0'].flatMap(version =>
      [true, false].map((flatChunks): Case => ({
        name: `follows the page's build of a package a flat remote loads at runtime (${version}, flat chunks=${flatChunks})`,
        hosts: ['host'],
        entries: [
          entry('host', shared(CORE, { pool: false, chunked: true, entrypoints: [TESTING] })),
        ],
        dynamic: [
          entry(
            'r',
            shared(TESTING, { pool: false, version, range: `^${version}` }),
            shared(CORE, { pool: false, version, range: `^${version}` }),
            ...(flatChunks ? [flatChunk('r')] : [])
          ),
        ],
        expectMap: map => {
          expect(resolve(map, CORE, 'http://r/expose.js')).toBe('http://host/fw_core.js');
          expect(resolve(map, TESTING, 'http://r/expose.js')).toBe(
            'http://host/fw_core_testing.js'
          );
        },
      }))
    ),
    // Unpooled, all lenient. The host's 17.2.0 build ships core alone; r0's 17.1.0 build ships core and sub, so
    // init runs r0 wholly from its own build. r7, loaded at runtime at 17.0.0, ships core and sub too: the
    // map serves only core, so r7 runs both from its own build, on the load's page and on the next one.
    ...[false, true].map((reload): Case => ({
      name: `runs a loaded remote wholly from its own build when the page serves only part of its package (reload=${reload})`,
      hosts: ['host'],
      deps: { [SUB]: [CORE] },
      entries: [
        entry('host', shared(CORE, { pool: false, version: '17.2.0', range: '^17.0.0' })),
        entry(
          'r0',
          shared(CORE, { pool: false, version: '17.1.0', range: '^17.0.0', entrypoints: [SUB] })
        ),
      ],
      dynamic: [
        entry(
          'r7',
          shared(CORE, { pool: false, version: '17.0.0', range: '^17.0.0', entrypoints: [SUB] })
        ),
      ],
      reload,
      expectMap: map => {
        expect(map.imports[CORE]).toBe('http://host/fw_core.js');
        expect(resolve(map, CORE, 'http://r7/expose.js')).toBe('http://r7/fw_core.js');
        expect(resolve(map, SUB, 'http://r7/expose.js')).toBe('http://r7/fw_core_sub.js');
      },
    })),
    // A load at a newer patch the page's build satisfies (1.0.1 under `~1.0.0`): with the same entrypoints it
    // runs the page's build; with an entrypoint the page lacks, its whole package from its own.
    ...pools.flatMap(pool =>
      [false, true].map((extra): Case => ({
        name: `runs a load at a compatible tag ${extra ? 'with an extra entrypoint from its own build' : "from the page's build"} (pool=${pool})`,
        hosts: ['host'],
        deps: { [INTEROP]: [CORE] },
        entries: [entry('host', shared(CORE, { pool, version: '1.0.0', range: '~1.0.0' }))],
        dynamic: [
          entry(
            'mfe',
            shared(CORE, {
              pool,
              version: '1.0.1',
              range: '~1.0.0',
              ...(extra && { entrypoints: [INTEROP] }),
            })
          ),
        ],
        expectMap: map => {
          const owner = extra ? 'mfe' : 'host';
          expect(resolve(map, CORE, 'http://mfe/expose.js')).toBe(`http://${owner}/fw_core.js`);
          if (extra)
            expect(resolve(map, INTEROP, 'http://mfe/expose.js')).toBe(
              'http://mfe/fw_core_interop.js'
            );
        },
      }))
    ),
    // The host ships only a flat testing@1.0.0; r ships a dense core@2.0.0 that lists testing. The root's
    // share row decides who serves the package: unpooled, both run core and testing from r's build; pooled,
    // the election scopes r's family and the host keeps its own testing. Clean in either registration order.
    ...pools.flatMap(pool =>
      [true, false].map((hostFirst): Case => {
        const host = entry('host', shared(TESTING, { pool, ...at('1.0.0') }));
        const r = entry('r', shared(CORE, { pool, ...at('2.0.0'), entrypoints: [TESTING] }));
        return {
          name: `takes a package from its root's build when the host ships only a flat secondary (pool=${pool}, host first=${hostFirst})`,
          hosts: ['host'],
          entries: hostFirst ? [host, r] : [r, host],
          expectMap: map =>
            expect(map.imports[TESTING]).toBe(
              pool ? 'http://host/fw_core_testing.js' : 'http://r/fw_core_testing.js'
            ),
        };
      })
    ),
    // r, loaded at runtime under strict compatibility, ships core/sub without core; a's build has no sub. The load
    // runs r's sub from r's own scope, and the next page's warm init keeps it there instead of publishing it beside
    // a's core. r's sub still imports a's core, the one stitch a cold init of the same portfolio has too.
    {
      name: 'runs a secondary a load ships without its root from its own scope on the warm page, as a cold init does',
      entries: [entry('a', shared(CORE))],
      dynamic: [
        entry(
          'r',
          { ...shared(CORE, { strict: true }), entries: { [SUB]: file(SUB) } },
          shared(FORMS, { strict: true })
        ),
      ],
      strict: true,
      deps: { [SUB]: [CORE] },
      reload: true,
      expectFaults: { r: { stitched: ['@fw/core: a r'] } },
      expectMap: map => {
        expect(map.imports[SUB]).toBeUndefined();
        expect(resolve(map, SUB, 'http://r/expose.js')).toBe('http://r/fw_core_sub.js');
      },
    },
  ];

  for (const c of cases) register(c);
});

// The host's files may import a specifier its build never declared (an entrypoint its build skipped, or a dynamic
// `import()` the build tool missed); init sees only what builds declare, so it never fills that gap from another
// build, even one of the same tag. The remote that ships the specifier runs the whole package from its own build
// instead. Dense: r lists interop in its core; flat: r ships interop as an external of its own.
describe('the host never borrows an entrypoint', () => {
  // The host ships only interop, whose file imports core; r ships core alone. The host's import stays
  // unresolved rather than binding r's core, and r runs core from its own build.
  const rootGap = [true, false].map((hostFirst): Case => {
    const host = entry('host', shared(INTEROP));
    const r = entry('r', shared(CORE));
    return {
      name: `leaves the root unmapped when the host ships only a secondary that imports it (host first=${hostFirst})`,
      hosts: ['host'],
      deps: { [INTEROP]: [CORE] },
      entries: hostFirst ? [host, r] : [r, host],
      expectFaults: { host: { unresolved: ['http://host/fw_core_interop.js -> @fw/core'] } },
      expectMap: map => {
        expect(map.imports[CORE]).toBeUndefined();
        expect(resolve(map, CORE, 'http://r/expose.js')).toBe('http://r/fw_core.js');
      },
    };
  });

  // As above, beside r, which ships core and interop, and s, which ships core alone. No remote's copy
  // replaces the host's interop, so the root stays unmapped and the host's import unresolved; r and s run
  // core from r's build.
  const rootGapBesideFamily = [true, false].map((hostFirst): Case => {
    const host = entry('host', shared(INTEROP));
    const others = [entry('r', shared(CORE, { entrypoints: [INTEROP] })), entry('s', shared(CORE))];
    return {
      name: `leaves the root unmapped when the host ships only a secondary a remote ships with its root (host first=${hostFirst})`,
      hosts: ['host'],
      deps: { [INTEROP]: [CORE] },
      entries: hostFirst ? [host, ...others] : [...others, host],
      expectFaults: { host: { unresolved: ['http://host/fw_core_interop.js -> @fw/core'] } },
      expectMap: map => {
        expect(map.imports[CORE]).toBeUndefined();
        expect(resolve(map, CORE, 'http://r/expose.js')).toBe('http://r/fw_core.js');
        expect(resolve(map, INTEROP, 'http://r/expose.js')).toBe('http://r/fw_core_interop.js');
        expect(resolve(map, CORE, 'http://s/expose.js')).toBe('http://r/fw_core.js');
      },
    };
  });

  // Unpooled, the same shape is not a gap in the map: r's core row serves the root globally and the host's
  // interop moves to the host's scope, where its import of core binds r's. No build ships both, so the host
  // runs core from two builds; only a build of the host that ships its root avoids it.
  const unpooledRootGap = [true, false].map((hostFirst): Case => {
    const host = entry('host', shared(INTEROP, { pool: false }));
    const r = entry('r', shared(CORE, { pool: false }));
    return {
      name: `serves the root from a remote when the unpooled host ships only a secondary (host first=${hostFirst})`,
      hosts: ['host'],
      deps: { [INTEROP]: [CORE] },
      entries: hostFirst ? [host, r] : [r, host],
      expectFaults: { host: { stitched: ['@fw/core: host r'] } },
      expectMap: map => {
        expect(map.imports[CORE]).toBe('http://r/fw_core.js');
        expect(map.imports[INTEROP]).toBeUndefined();
        expect(map.scopes?.['http://host/']?.[INTEROP]).toBe('http://host/fw_core_interop.js');
      },
    };
  });

  const cases: Case[] = pools.flatMap(pool =>
    (['dense', 'flat'] as const).flatMap(layout =>
      [true, false].map((hostFirst): Case => {
        const host = entry('host', shared(CORE, { pool }));
        const r =
          layout === 'dense'
            ? entry('r', shared(CORE, { pool, entrypoints: [INTEROP] }))
            : entry('r', shared(CORE, { pool }), shared(INTEROP, { pool }));
        return {
          name: `leaves a specifier the host lacks unmapped even when a same-tag remote ships it (pool=${pool}, ${layout}, host first=${hostFirst})`,
          hosts: ['host'],
          entries: hostFirst ? [host, r] : [r, host],
          expectMap: map => {
            expect(map.imports[CORE]).toBe('http://host/fw_core.js');
            expect(map.imports[INTEROP]).toBeUndefined();
            expect(resolve(map, CORE, 'http://r/expose.js')).toBe('http://r/fw_core.js');
            expect(resolve(map, INTEROP, 'http://r/expose.js')).toBe('http://r/fw_core_interop.js');
          },
        };
      })
    )
  );

  for (const c of [...cases, ...rootGap, ...rootGapBesideFamily, ...unpooledRootGap]) register(c);
});
