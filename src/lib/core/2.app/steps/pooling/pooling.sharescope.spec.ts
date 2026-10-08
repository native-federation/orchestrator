import {
  GLOBAL_SCOPE,
  type DenseSharedInfo,
  type RemoteEntry,
  type SharedVersion,
} from 'lib/core/1.domain';
import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';
import { tearsByPool } from 'lib/testing/pooling/no-tear';
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

    it(`the flat build elected: the dense remotes take its flat entrypoint (${shareScope ?? 'global'})`, async () => {
      const p = rig(shareScope);

      const importMap = await p.runInit(remotes('^2.0.0', shareScope));

      expect(tears(p, importMap, shareScope)).toEqual([]);
      expect(own(importMap, 'W')).toEqual({
        '@fw/core': 'http://G/@fw_core.js',
        '@fw/core/testing': 'http://G/@fw_core_testing.js',
      });
    });

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
