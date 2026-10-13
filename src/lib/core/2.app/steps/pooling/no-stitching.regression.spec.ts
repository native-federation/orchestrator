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
  hosts?: string[];
  scope?: string;
  // What a file imports beyond its own package's entrypoints and chunks.
  deps?: Record<string, string[]>;
  // The case's own expectations on the fixed map, beyond a clean oracle verdict.
  expectMap?: (map: ImportMap) => void;
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
      ...(c.scope && { scope: c.scope }),
    }
  );
  let map: ImportMap = await p.runInit(c.entries);
  for (const d of c.dynamic ?? []) map = (await p.runDynamic(d)).merged;
  const faults = pageFaults({
    importMap: map,
    entries: [...c.entries, ...(c.dynamic ?? [])],
    hosts: c.hosts,
    importsOf: importsFrom(c.deps ?? {}),
  });
  return { map, faults };
};

const register = (c: Case) => {
  (c.known ? it.fails : it)(c.name, async () => {
    const { map, faults } = await run(c);
    expect(faults).toEqual({});
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
    // Unpooled, on 4.7.0 too. The host's core leads the 17.0.0 row; b's copy adds interop,
    // whose file imports b's chunk: b runs b's core internals beside the host's core.
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
      known: { b: { torn: ['@fw/core: a b'], stitched: ['@fw/core: a* b*'] } },
    },
    // Pooled: the host pins core in round 1, so no chunk guard sees mfe's chunked interop.
    {
      name: 'serves no chunked entrypoint beside the pinned host core',
      hosts: ['host'],
      entries: [
        entry('mfe', shared(CORE, { chunked: true, entrypoints: [INTEROP] })),
        entry('host', shared(CORE, { chunked: true })),
      ],
      known: { mfe: { torn: ['@fw/core: host mfe'], stitched: ['@fw/core: host* mfe*'] } },
    },
    // u lends interop to the host's core and chunked c ships it too; c registers first, so
    // its copy leads the row and the map publishes c's interop, which binds c's core internals.
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
      known: {
        c: { torn: ['@fw/core: c host'], stitched: ['@fw/core: c* host'] },
        u: { torn: ['@fw/core: c host'], stitched: ['@fw/core: c* host'] },
      },
    },
    // r3 wins with core alone and borrows testing from r1, which forms keeps off the map;
    // only chunked r0 still ships testing globally, so the loan is kept and the map runs r0's testing beside
    // r3's core.
    {
      name: "runs testing from its core's build when only a chunked copy ships it globally",
      entries: [
        entry('r0', shared(CORE, { ...at('17.0.1'), chunked: true, entrypoints: [TESTING] })),
        entry('r1', shared(CORE, { ...at('17.0.1'), entrypoints: [TESTING] }), shared(FORMS)),
        entry('r2', shared(FORMS, at('17.0.1'))),
        entry('r3', shared(CORE, at('17.0.1')), shared('@fw/x')),
      ],
      known: {
        r0: { torn: ['@fw/core: r0 r3'], stitched: ['@fw/core: r0* r3'] },
        r1: { torn: ['@fw/core: r0 r3'], stitched: ['@fw/core: r0* r3'] },
      },
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
    // h ships core without interop and rxjs 7.8.0. Both files import rxjs, each through its own URL: u runs the
    // host's core on rxjs 7 beside its own interop on rxjs 6. Without a host the same map leaks the winner's
    // scope, a separate defect that one build per package does not fix, so that variant is not here.
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
        known: {
          u: {
            twice: ['rxjs: http://h/rxjs.js http://u/rxjs.js'],
            torn: ['rxjs: h u'],
            stitched: ['@fw/core: h u', 'rxjs: h u'],
          },
        },
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
    // b's `core/b` imports `core/a`, which the map serves from the host a's build; from b's
    // URL, with no scope row for it, it binds a's `core/a`. Chunked, b's `core/b` pulls b's internals beside
    // a's; unchunked nothing loads twice, yet b and r run core from two builds.
    ...[true, false].map((chunked): Case => ({
      name: `runs no entrypoint that imports a sibling another build serves (chunked=${chunked})`,
      hosts: ['a'],
      entries: [
        entry('b', shared(CORE, { chunked, entrypoints: [A, B] })),
        entry('r', shared(CORE, { chunked, entrypoints: [A, B] })),
        entry('a', shared(CORE, { chunked, entrypoints: [A] })),
      ],
      known: chunked
        ? {
            b: { torn: ['@fw/core: a b'], stitched: ['@fw/core: a* b*'] },
            r: { torn: ['@fw/core: a b'], stitched: ['@fw/core: a* b*'] },
          }
        : { b: { stitched: ['@fw/core: a b'] }, r: { stitched: ['@fw/core: a b'] } },
    })),
    // b lends interop and scopes forms to its own strict 16.0.0; interop imports forms. r
    // runs the map's forms (17) and b's interop, which binds forms through b's URL.
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
      known: {
        b: { stitched: ['@fw/core: a b'] },
        r: {
          twice: ['@fw/forms: http://a/fw_forms.js http://b/fw_forms.js'],
          torn: ['@fw/forms: a b'],
          stitched: ['@fw/core: a b', '@fw/forms: a b'],
        },
      },
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
    // A remote loaded at runtime self-fills interop in its own scope, but its
    // bundle's chunk is never mapped there.
    ...pools.map((pool): Case => ({
      name: `maps the chunks of every entrypoint a dynamic remote runs (pool=${pool})`,
      hosts: ['host'],
      entries: [entry('host', shared(CORE, { pool, chunked: true }))],
      dynamic: [entry('mfe4', shared(CORE, { pool, chunked: true, entrypoints: [INTEROP] }))],
      known: {
        mfe4: {
          unresolved: ['http://mfe4/fw_core_interop.js -> @nf-internal/chunk-browser-fw_core'],
          stitched: ['@fw/core: host* mfe4*'],
        },
      },
    })),
    // The dense chunked host lists
    // testing; flat r, loaded at runtime, ships strict core@16 and testing@16. Its core is scoped, but its
    // testing external has no share row of its own, so the load shares it: the delta maps testing in
    // `imports`, which the page already maps, and a browser rejects the override. r runs the host's testing,
    // which binds the host's core.
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
      known: {
        r: {
          twice: ['@fw/core: http://host/fw_core.js http://r/fw_core.js'],
          torn: ['@fw/core: host r'],
          stitched: [`@fw/core: host* r${flatChunks ? '*' : ''}`],
        },
      },
    })),
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
  ];

  for (const c of cases) register(c);
});
