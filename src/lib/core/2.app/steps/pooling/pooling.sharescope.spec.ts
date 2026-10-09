import {
  GLOBAL_SCOPE,
  type DenseSharedInfo,
  type RemoteEntry,
  type SharedVersion,
} from 'lib/core/1.domain';
import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';
import { tearsByPool } from 'lib/testing/pooling/no-tear';
import { outcome } from 'lib/testing/pooling/property-harness';
import { portfolio } from 'lib/testing/pooling/portfolio';

/**
 * Pooling in a named share scope, through to the import map. `generate-import-map.ts` maps a subpool's
 * `servedBy` copies for named scopes in `processShareScope`, a re-implementation of the global path's
 * `collectServed`/`flushServed`. Nothing else covers it.
 *
 * This pins today's behaviour, quirks included. Reusing the global helpers there would change the
 * expectations marked QUIRK, and only those.
 */
describe('pooling in a named share scope', () => {
  const SCOPE = {
    'team/a': 'http://a/',
    'team/b': 'http://b/',
    'team/legacy-a': 'http://legacy-a/',
    'team/legacy-b': 'http://legacy-b/',
  };

  let p: ReturnType<typeof portfolio>;
  beforeEach(() => {
    p = portfolio(SCOPE, { scope: 'team-x', storage: 'nf-pooling-sharescope' });
  });

  // Two 21 remotes beside a 22 majority: legacy-a's build serves legacy-b (~21.2.0 takes 21.2.18), so
  // they form a subpool on legacy-a's build.
  const seedSubpool = () => {
    p.seed('@framework/core', [
      p.version('22.0.8', '@framework/core', [
        { remote: 'team/a', req: '^22.0.0' },
        { remote: 'team/b', req: '^22.0.0' },
      ]),
      p.version('21.2.18', '@framework/core', [{ remote: 'team/legacy-a', req: '~21.2.0' }]),
      p.version('21.2.15', '@framework/core', [{ remote: 'team/legacy-b', req: '~21.2.0' }]),
    ]);
    p.seed('@framework/router', [
      p.version('22.0.8', '@framework/router', [{ remote: 'team/a', req: '^22.0.0' }]),
      p.version('21.2.18', '@framework/router', [{ remote: 'team/legacy-a', req: '~21.2.0' }]),
    ]);
  };

  // A stored copy of a legacy remote, running legacy-a's build.
  const servedByLegacyA = (version: SharedVersion): SharedVersion => ({
    ...version,
    remotes: version.remotes.map(r =>
      r.name.startsWith('team/legacy') ? { ...r, servedBy: 'team/legacy-a' } : r
    ),
  });

  it('maps each subpool member onto its build in its own scope', async () => {
    seedSubpool();

    const importMap = await p.runInit();

    expect(p.islands()).toEqual({
      'team/legacy-a': 'subpool team/legacy-a',
      'team/legacy-b': 'subpool team/legacy-a',
    });
    // A named scope publishes nothing in `imports`: every remote, the elected build's included, gets its
    // mappings in its own scope.
    expect(importMap).toEqual({
      imports: {},
      scopes: {
        'http://a/': {
          '@framework/core': 'http://a/@framework/core.js',
          '@framework/router': 'http://a/@framework/router.js',
        },
        'http://b/': { '@framework/core': 'http://a/@framework/core.js' },
        'http://legacy-a/': {
          '@framework/core': 'http://legacy-a/@framework/core.js',
          '@framework/router': 'http://legacy-a/@framework/router.js',
        },
        'http://legacy-b/': { '@framework/core': 'http://legacy-a/@framework/core.js' },
      },
    });
  });

  it('drops a servedBy specifier its build does not ship, without a warning', async () => {
    // A stored subpool whose build no longer ships router: legacy-b still names legacy-a for it. Warm, so
    // nothing re-elects the record and the map is generated from it as stored. Generated directly: the
    // unmapped specifier is the point, and the harness would refuse it.
    const stored = { poolName: 'framework', poolWinner: 'team/a' };
    p.seed(
      '@framework/core',
      [
        p.version('22.0.8', '@framework/core', [{ remote: 'team/a', req: '^22.0.0' }], 'share'),
        p.version('21.2.18', '@framework/core', [
          { remote: 'team/legacy-a', req: '~21.2.0' },
          { remote: 'team/legacy-b', req: '~21.2.0' },
        ]),
      ].map(servedByLegacyA),
      false,
      stored
    );
    p.seed(
      '@framework/router',
      [
        p.version('22.0.8', '@framework/router', [{ remote: 'team/a', req: '^22.0.0' }], 'share'),
        p.version('21.2.18', '@framework/router', [{ remote: 'team/legacy-b', req: '~21.2.0' }]),
      ].map(servedByLegacyA),
      false,
      stored
    );

    const importMap = await p.drivers.generateImportMap();

    // QUIRK: the global path warns "'team/legacy-a' does not serve '@framework/router'"; this one is silent.
    // Either way the specifier is left unmapped for legacy-b.
    expect(importMap.scopes?.['http://legacy-b/']).toEqual({
      '@framework/core': 'http://legacy-a/@framework/core.js',
    });
    expect(p.config.log.warn).not.toHaveBeenCalled();
  });
});

/**
 * One pool shipped dense by W and W2 (`@fw/core` with the entry `@fw/core/testing`) and flat by G (each
 * entrypoint a package of its own). In the global scope `imports` gives every remote one file per specifier;
 * a named scope must map each remote's own scope the same way.
 *
 * The no-tear oracle runs explicitly on each map (the harness's own check is off), so every case fails on a
 * tear even before its mapping expectation.
 */
describe('flat and dense builds of one pool in a share scope', () => {
  const shared = (packageName: string, version: string, range: string, shareScope?: string) =>
    ({
      packageName,
      version,
      requiredVersion: range,
      singleton: true,
      strictVersion: true,
      pool: 'fw',
      ...(shareScope && { shareScope }),
      entries: Object.fromEntries(
        (packageName === '@fw/core' && version === '2.0.0'
          ? ['@fw/core', '@fw/core/testing']
          : [packageName]
        ).map(s => [s, `${s.replace(/\//g, '_')}.js`])
      ),
    }) as DenseSharedInfo;
  const entry = (name: string, ...info: DenseSharedInfo[]) =>
    ({
      name,
      url: `http://${name}/remoteEntry.json`,
      exposes: [],
      shared: info,
    }) as unknown as RemoteEntry;
  const remotes = (range: string, shareScope?: string) => [
    entry('W', shared('@fw/core', '2.0.0', range, shareScope)),
    entry('W2', shared('@fw/core', '2.0.0', range, shareScope)),
    entry(
      'G',
      shared('@fw/core', '2.0.1', '^2.0.0', shareScope),
      shared('@fw/core/testing', '2.0.1', '^2.0.0', shareScope)
    ),
  ];
  const rig = (shareScope?: string) =>
    portfolio(
      {},
      { realRepositories: true, assertNoTear: false, ...(shareScope && { scope: shareScope }) }
    );
  const tears = (p: ReturnType<typeof portfolio>, importMap: ImportMap, shareScope?: string) =>
    tearsByPool({
      importMap,
      externals: { [shareScope ?? GLOBAL_SCOPE]: p.stored() },
      scopeUrls: p.scopeUrls(),
    });

  for (const shareScope of [undefined, 'team']) {
    const own = (importMap: ImportMap, remote: string) =>
      shareScope ? importMap.scopes?.[`http://${remote}/`] : importMap.imports;

    for (const strictImportMap of [false, true])
      it(`the dense build elected: the flat remote takes its entry (${shareScope ?? 'global'}, strictImportMap ${strictImportMap})`, async () => {
        const p = rig(shareScope);
        // Elects W's dense 2.0.0 over G's newer 2.0.1 (W and W2 pin 2.0.0 exactly); latest-first would elect G.
        p.config.profile.latestSharedExternal = false;
        p.config.strict.strictImportMap = strictImportMap;

        const importMap = await p.runInit(remotes('2.0.0', shareScope));

        expect(tears(p, importMap, shareScope)).toEqual([]);
        expect(own(importMap, 'G')).toEqual({
          '@fw/core': 'http://W/@fw_core.js',
          '@fw/core/testing': 'http://W/@fw_core_testing.js',
        });
      });
  }
});

/**
 * A remote loaded at runtime into a pool where one build ships an entrypoint as a package of its own (flat)
 * and another as an entry of its package (dense). The pool's verdict for the load is global: a committed
 * build witnesses every tag the map would hand it. So the load must run the map's files for every specifier
 * the map serves, though `update-cache` judges per external and sees those specifiers as uncovered (a skip)
 * or the package as nobody's (a share). And the record it leaves must rebuild the same page: a load that
 * points at the map is recorded as a skip, never as a new shared version.
 */
describe('a load into a pool of flat and dense builds, and the page after it', () => {
  const shared = (packageName: string, version: string, entries: string[], shareScope?: string) =>
    ({
      packageName,
      version,
      requiredVersion: `^${version.split('.')[0]}.0.0`,
      singleton: true,
      strictVersion: false,
      pool: 'fw',
      ...(shareScope && { shareScope }),
      entries: Object.fromEntries(entries.map(s => [s, `${s.replace(/\//g, '_')}.js`])),
    }) as DenseSharedInfo;
  const entry = (name: string, ...info: DenseSharedInfo[]) =>
    ({
      name,
      url: `http://${name}/remoteEntry.json`,
      exposes: [],
      shared: info,
    }) as unknown as RemoteEntry;

  type Case = { committed: RemoteEntry[]; load: RemoteEntry };
  const cases: [string, (shareScope?: string) => Case][] = [
    [
      // G ships `@fw/core/testing` as a package of its own, so the shared version of `@fw/core` the
      // resolver reads lacks it: L's `@fw/core` is a skip that would self-fill testing from its own 2.0.0.
      "a skipped package takes the entrypoint the flat build's own package serves",
      shareScope => ({
        committed: [
          entry('W', shared('@fw/core', '2.0.0', ['@fw/core', '@fw/core/testing'], shareScope)),
          entry(
            'G',
            shared('@fw/core', '2.0.1', ['@fw/core'], shareScope),
            shared('@fw/core/testing', '2.0.1', ['@fw/core/testing'], shareScope)
          ),
        ],
        load: entry('L', shared('@fw/core', '2.0.0', ['@fw/core', '@fw/core/testing'], shareScope)),
      }),
    ],
    [
      // Nobody shares a package `@fw/http`, only the flat `@fw/http/testing`: L's `@fw/http` is a share,
      // which in a named scope maps its own 17.1.1 beside the 17.0.0 `@fw/core` it skips onto.
      'a package nobody shares points at the flat package serving its entrypoint',
      shareScope => ({
        committed: [
          entry(
            'F',
            shared('@fw/core', '17.0.0', ['@fw/core'], shareScope),
            shared('@fw/http/testing', '17.0.0', ['@fw/http/testing'], shareScope)
          ),
        ],
        load: entry(
          'L',
          shared('@fw/core', '17.1.1', ['@fw/core'], shareScope),
          shared('@fw/http', '17.1.1', ['@fw/http/testing'], shareScope)
        ),
      }),
    ],
    [
      // As above, but D's `@fw/http` is committed as a skip-only package (F's build was elected, and D's
      // 17.0.1 runs F's files), stored ahead of `@fw/http/testing`. A new shared version of `@fw/http`
      // would claim `@fw/http/testing` first on the next page and hand every remote L's 17.1.1.
      'a skip-only package stays skip-only, so the next page keeps the flat package serving',
      shareScope => ({
        committed: [
          entry('D', shared('@fw/http', '17.0.1', ['@fw/http/testing'], shareScope)),
          entry(
            'F',
            shared('@fw/core', '17.0.0', ['@fw/core'], shareScope),
            shared('@fw/http/testing', '17.0.0', ['@fw/http/testing'], shareScope)
          ),
        ],
        load: entry(
          'L',
          shared('@fw/core', '17.1.1', ['@fw/core'], shareScope),
          shared('@fw/http', '17.1.1', ['@fw/http/testing'], shareScope)
        ),
      }),
    ],
  ];

  for (const shareScope of [undefined, 'team'])
    for (const [name, fixture] of cases)
      it(`${name} (${shareScope ?? 'global'})`, async () => {
        const { committed, load } = fixture(shareScope);
        const p = portfolio(
          {},
          { realRepositories: true, assertNoTear: false, ...(shareScope && { scope: shareScope }) }
        );
        const tears = (importMap: ImportMap) =>
          tearsByPool({
            importMap,
            externals: { [shareScope ?? GLOBAL_SCOPE]: p.stored() },
            scopeUrls: p.scopeUrls(),
          });
        await p.runInit(committed);
        p.reload();

        const { merged } = await p.runDynamic(load);
        const page = outcome(merged, p.stored()).runs;

        expect(tears(merged)).toEqual([]);
        expect(
          Object.entries(p.stored()).flatMap(([external, { versions }]) =>
            versions
              .filter(v => v.action === 'share' && v.remotes.some(r => r.name === 'L'))
              .map(v => `${external}@${v.tag}`)
          )
        ).toEqual([]);

        p.reload();
        const warm = await p.runInit([...committed, load]);

        expect(tears(warm)).toEqual([]);
        expect(outcome(warm, p.stored()).runs).toEqual(page);
      });

  // L's `@fw/http` 17.0.0 ships its root, which nobody serves, beside `@fw/http/testing`, which F's flat
  // package serves. Under `strictImportMap` a named scope's next page refuses a skip-only package with an
  // entrypoint no shared version serves, so the share stays. Stored after D's skip-only `@fw/http`, ahead of
  // `@fw/http/testing`, it claims testing on the next page: harmless, since L reached the global verdict by
  // agreeing with the map, so it claims F's tag.
  it('a share served in part stays a share under strictImportMap, and the next page stays whole (team)', async () => {
    const shareScope = 'team';
    const p = portfolio({}, { realRepositories: true, assertNoTear: false, scope: shareScope });
    const strict = () => (p.config.strict.strictImportMap = true);
    const tears = (importMap: ImportMap) =>
      tearsByPool({
        importMap,
        externals: { [shareScope]: p.stored() },
        scopeUrls: p.scopeUrls(),
      });
    const committed = [
      entry('D', shared('@fw/http', '17.0.1', ['@fw/http/testing'], shareScope)),
      entry(
        'F',
        shared('@fw/core', '17.0.0', ['@fw/core'], shareScope),
        shared('@fw/http/testing', '17.0.0', ['@fw/http/testing'], shareScope)
      ),
    ];
    const load = entry(
      'L',
      shared('@fw/core', '17.0.0', ['@fw/core'], shareScope),
      shared('@fw/http', '17.0.0', ['@fw/http', '@fw/http/testing'], shareScope)
    );
    strict();
    await p.runInit(committed);
    p.reload();
    strict();

    const { actions, merged } = await p.runDynamic(load);
    const page = outcome(merged, p.stored()).runs;

    expect(actions['@fw/http']!.action).toBe('share');
    expect(tears(merged)).toEqual([]);
    expect(Object.keys(p.stored()).indexOf('@fw/http')).toBeLessThan(
      Object.keys(p.stored()).indexOf('@fw/http/testing')
    );

    p.reload();
    strict();
    const warm = await p.runInit([...committed, load]);

    expect(tears(warm)).toEqual([]);
    expect(outcome(warm, p.stored()).runs).toEqual(page);
    expect(page['D|@fw/http/testing']).toBe('17.0.0');
  });

  // F ships `@fw/core/testing` as a package of its own, D as an entry of its `@fw/core`, both at 2.0.0. The
  // page maps D's file for testing in every scope. L, a copy of F, skips F's flat package at its own tag, so
  // `update-cache` points that skip at F's file: the same tag, but a second module instance of the singleton.
  it("a load runs the committed scopes' file, not a copy at its tag (team)", async () => {
    const shareScope = 'team';
    const p = portfolio({}, { realRepositories: true, assertNoTear: false, scope: shareScope });
    const flat = (name: string) =>
      entry(
        name,
        shared('@fw/core', '2.0.0', ['@fw/core'], shareScope),
        shared('@fw/core/testing', '2.0.0', ['@fw/core/testing'], shareScope)
      );
    const committed = [
      flat('F'),
      entry('D', shared('@fw/core', '2.0.0', ['@fw/core', '@fw/core/testing'], shareScope)),
    ];
    const init = await p.runInit(committed);
    p.reload();

    const { merged } = await p.runDynamic(flat('L'));

    const files = (importMap: ImportMap, remote: string) => importMap.scopes?.[`http://${remote}/`];
    expect(files(init, 'F')).toEqual(files(init, 'D'));
    expect(files(init, 'D')).toEqual({
      '@fw/core': 'http://D/@fw_core.js',
      '@fw/core/testing': 'http://D/@fw_core_testing.js',
    });
    expect(files(merged, 'L')).toEqual(files(init, 'D'));
  });

  // As above with the shapes swapped and F's flat `@fw/core/testing` stored ahead of D's dense `@fw/core`: the
  // page maps F's file for testing in every scope, the first stored package claiming it. L, a copy of D, skips
  // `@fw/core`, whose shared version names D's testing. Pool members come in name order, `@fw/core` first, so
  // a committed view walking them would name D's too.
  it("a load runs the first stored package's file, not its own (team)", async () => {
    const shareScope = 'team';
    const p = portfolio({}, { realRepositories: true, assertNoTear: false, scope: shareScope });
    const dense = (name: string) =>
      entry(name, shared('@fw/core', '2.0.0', ['@fw/core', '@fw/core/testing'], shareScope));
    const committed = [
      entry(
        'F',
        shared('@fw/core/testing', '2.0.0', ['@fw/core/testing'], shareScope),
        shared('@fw/core', '2.0.0', ['@fw/core'], shareScope)
      ),
      dense('D'),
    ];
    const init = await p.runInit(committed);
    p.reload();

    const { merged } = await p.runDynamic(dense('L'));

    const files = (importMap: ImportMap, remote: string) => importMap.scopes?.[`http://${remote}/`];
    expect(Object.keys(p.stored())).toEqual(['@fw/core/testing', '@fw/core']);
    expect(files(init, 'D')).toEqual({
      '@fw/core': 'http://D/@fw_core.js',
      '@fw/core/testing': 'http://F/@fw_core_testing.js',
    });
    expect(files(merged, 'L')).toEqual(files(init, 'D'));
  });
});
