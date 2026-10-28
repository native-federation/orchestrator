import fc from 'fast-check';
import { GLOBAL_SCOPE, type ImportMap, type RemoteEntry, type shareScope } from 'lib/core/1.domain';
import {
  generatedImports,
  hostOf,
  portfolioArbitrary,
  redeployArbitrary,
  redeployedEntries,
  scopeUrlOf,
  toRemoteEntries,
  type PortfolioSpec,
  type Redeploy,
} from 'lib/testing/pooling/generate-portfolio';
import {
  TIMEOUT,
  copiesOf,
  fileSplits,
  initOrRefuse,
  lenient,
  openPortfolio,
  outcome,
  poolNameDrift,
  poolTears,
  pools,
  rangeViolations,
  run,
  scopeUrlsOf,
  strayNames,
} from 'lib/testing/pooling/property-harness';
import * as _path from 'lib/utils/path';
import { copiesByRemote } from 'lib/core/1.domain/pooling/builds';
import { committedView } from 'lib/core/1.domain/pooling/gate';
import { packageOfIn } from 'lib/core/1.domain/externals/specifier';
import { pageFaults, resolve } from 'lib/testing/pooling/page-graph';
import { NFError } from 'lib/core/native-federation.error';

/**
 * Pooling invariants over generated portfolios (`generate-portfolio.ts`), through the real init steps with
 * real semver; the dynamic path is `pooling.property.dynamic.spec.ts`. Each property runs its own fixed seed,
 * so a failure reproduces; fast-check prints the shrunk spec. A counterexample found here belongs in the
 * regression section at the bottom.
 *
 * The generator covers 1-20 remotes, 1-3 pools of 2-6 members with 2-4 builds each that remotes redeploy
 * (plus one-off stragglers), two majors x three minors (plus patches and rare prereleases), `^`/`~`/exact
 * ranges, `^<major>.0.0` and "drifted" ranges that exclude the remote's own tag, ragged member and entrypoint
 * sets, an optional host, and `strictVersion` / `strictExternalCompatibility` on or off. The properties that
 * draw `latestSharedExternal` judge the round-1 order it changes (newest build first) and the stored winner a
 * warm page keeps under it.
 *
 * A deeper local search: POOLING_PROPERTY_SEED=<n> POOLING_PROPERTY_SCALE=<factor> (CI uses the defaults).
 */

const UNPOOLED_REFUSALS = [
  /^Could not determine shared externals in scope /,
  /^External \S+ could not be shared\.$/,
];

const unpooled = (entry: RemoteEntry): RemoteEntry => ({
  ...entry,
  shared: entry.shared.map(({ pool: _, ...info }) => info),
});

// A page's pools: the records that carry a pool name, and the map's files for the specifiers they ship.
const pooledPart = ({ importMap, record }: { importMap: ImportMap; record: shareScope }) => {
  const pooled = Object.fromEntries(
    Object.entries(record).filter(([, external]) => external.poolName !== undefined)
  );
  const specifiers = new Set(
    Object.values(pooled).flatMap(e =>
      e.versions.flatMap(v => v.remotes.flatMap(r => Object.keys(r.entries)))
    )
  );
  const only = (map: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(map).filter(([s]) => specifiers.has(s)));
  return {
    record: pooled,
    imports: only(importMap.imports),
    scopes: Object.fromEntries(
      Object.entries(importMap.scopes ?? {})
        .map(([url, map]) => [url, only(map)] as const)
        .filter(([, map]) => Object.keys(map).length > 0)
    ),
  };
};

// Per remote, the file each specifier it ships resolves to from its own URL.
const resolvedFiles = (importMap: ImportMap, entries: RemoteEntry[]) =>
  Object.fromEntries(
    entries.flatMap(entry =>
      entry.shared.flatMap(shared =>
        Object.keys(shared.entries).map(specifier => [
          `${entry.name}|${specifier}`,
          resolve(importMap, specifier, scopeUrlOf(entry.name)) ?? null,
        ])
      )
    )
  );

// The build each external's package is served from, as stored.
const servingBuilds = (record: shareScope) =>
  Object.fromEntries(
    Object.entries(record).map(([name, external]) => [name, external.servingBuild ?? null])
  );

describe('pooling properties: init (generated portfolios)', { timeout: TIMEOUT }, () => {
  // The two oracles run as separate properties, so a failure names which of them broke.
  it('no-tear (resolution): no remote resolves a combination no build shipped', () =>
    run(1, portfolioArbitrary({ latestSharedExternal: true }), 150, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      const { importMap, record } = init.result;
      for (const tear of poolTears(importMap, record, scopeUrlsOf(init.entries), init.host))
        expect({ pool: tear.pool, incoherent: tear.incoherent }).toEqual({
          pool: tear.pool,
          incoherent: [],
        });
    }));

  it('no-tear (binding): no file a remote reaches binds a second tag of any specifier', () =>
    run(
      2,
      portfolioArbitrary({
        labelNoise: true,
        latestSharedExternal: true,
      }),
      300,
      async spec => {
        const init = await initOrRefuse(spec);
        if (!init.ok) return;
        const { importMap, record } = init.result;
        for (const tear of poolTears(importMap, record, scopeUrlsOf(init.entries), init.host))
          expect({ pool: tear.pool, split: tear.split }).toEqual({ pool: tear.pool, split: [] });
      }
    ));

  // A build without `feature.convertFlatSharedInfo` ships an entrypoint as a package of its own, so one
  // specifier is an entry of one external and a package of another. In a named share scope every remote maps
  // in its own scope, so the import map must still give each the specifier the global path's `imports` would.
  // A build with `build: 'paths'` declares the entrypoint a package of its own, which holds only while no
  // other copy ships it as an entry of its package.
  for (const [offset, shareScope] of [
    [20, undefined],
    [21, 'team'],
  ] as const)
    it(`no-tear with flat and dense builds in one pool, ${shareScope ?? 'global'} share scope`, () =>
      run(
        offset,
        portfolioArbitrary({
          flat: true,
          dense: true,
          siblings: true,
          labelNoise: true,
          ...(shareScope && { shareScope }),
        }),
        200,
        async spec => {
          const init = await initOrRefuse(spec);
          if (!init.ok) return;
          const { importMap, record } = init.result;
          expect(
            poolTears(importMap, record, scopeUrlsOf(init.entries), init.host, shareScope)
          ).toEqual([]);
        }
      ));

  // The page oracle (`page-graph.ts`) per remote over every file its code reaches: one build per package, no
  // package's internals from two builds, no specifier at two URLs, nothing unresolved. Leaks (another package's
  // file binding a second build through its scope) are left out. A generated file never imports a root its
  // own build lacks, so a host shipping a secondary without its root (left unresolved) never arises.
  // Declared packages (`build: 'paths'`) are in the mix: their files are bundled per declared package.
  for (const [offset, shareScope] of [
    [40, undefined],
    [41, 'team'],
  ] as const)
    it(`page: every remote runs each package from one build, ${shareScope ?? 'global'} share scope`, () =>
      run(
        offset,
        portfolioArbitrary({
          flat: true,
          dense: true,
          siblings: true,
          chunks: true,
          labelNoise: true,
          ...(shareScope && { shareScope }),
        }),
        300,
        async spec => {
          const init = await initOrRefuse(spec);
          if (!init.ok) return;
          const { importMap } = init.result;
          expect(
            pageFaults({
              importMap,
              entries: init.entries,
              hosts: init.host === undefined ? [] : [init.host],
              importsOf: generatedImports(init.entries),
            })
          ).toEqual({});
        }
      ));

  // The page portfolios with every pool label dropped, so each package (flat secondaries included) is unpooled:
  // no remote's own specifiers of one package resolve to two builds. Leaks (another package's file binding a
  // second build through its scope) are not counted. A strict refusal is not judged for soundness here, only
  // recognized: unpooled, a strict copy can also fail sharing outright, which the pooled refusals do not list.
  for (const [offset, shareScope] of [
    [42, undefined],
    [43, 'team'],
  ] as const)
    it(`page: no unpooled remote resolves its own specifiers of a package to two builds, ${shareScope ?? 'global'} share scope`, () =>
      run(
        offset,
        portfolioArbitrary({
          flat: true,
          dense: true,
          siblings: true,
          chunks: true,
          ...(shareScope && { shareScope }),
        }),
        300,
        async spec => {
          const entries = toRemoteEntries(spec).map(unpooled);
          const host = hostOf(spec);
          const rig = openPortfolio({
            strict: spec.strict,
            host,
            scope: spec.shareScope,
            latestSharedExternal: spec.latestSharedExternal,
          });
          let importMap: ImportMap;
          try {
            ({ importMap } = await rig.init(entries));
          } catch (error) {
            const refused =
              spec.strict &&
              error instanceof NFError &&
              UNPOOLED_REFUSALS.some(refusal => refusal.test(error.message));
            if (!refused) throw error;
            return;
          }
          expect(fileSplits(importMap, entries, host)).toEqual([]);
        }
      ));

  it('order independence: any registration order runs the same tags with the same verdicts', () =>
    run(
      3,
      portfolioArbitrary().chain(spec =>
        fc.tuple(
          fc.constant(lenient(spec)),
          fc.shuffledSubarray(
            spec.remotes.map((_, i) => i),
            { minLength: spec.remotes.length, maxLength: spec.remotes.length }
          )
        )
      ),
      200,
      async ([spec, order]) => {
        const entries = toRemoteEntries(spec);
        const host = hostOf(spec);
        const a = await openPortfolio({ host }).init(entries);
        const b = await openPortfolio({ host }).init(order.map(i => entries[i]!));
        expect(outcome(b.importMap, b.record)).toEqual(outcome(a.importMap, a.record));
        expect(servingBuilds(b.record)).toEqual(servingBuilds(a.record));
      }
    ));

  // As above with flat and dense builds of one package side by side, chunked or not, with label noise,
  // globally and in a named share scope: ties between builds go to the remote's name, so the order remotes
  // register in picks neither the build that serves a package nor any file a remote runs.
  for (const [offset, shareScope] of [
    [30, undefined],
    [31, 'team'],
  ] as const)
    it(`order independence: any registration order serves each package from the same build and runs the same files, ${shareScope ?? 'global'} share scope`, () =>
      run(
        offset,
        portfolioArbitrary({
          flat: true,
          chunks: true,
          labelNoise: true,
          ...(shareScope && { shareScope }),
        }).chain(spec =>
          fc.tuple(
            fc.constant(lenient(spec)),
            fc.shuffledSubarray(
              spec.remotes.map((_, i) => i),
              { minLength: spec.remotes.length, maxLength: spec.remotes.length }
            )
          )
        ),
        200,
        async ([spec, order]) => {
          const entries = toRemoteEntries(spec);
          const host = hostOf(spec);
          const a = await openPortfolio({ host, scope: shareScope }).init(entries);
          const b = await openPortfolio({ host, scope: shareScope }).init(
            order.map(i => entries[i]!)
          );
          expect(servingBuilds(b.record)).toEqual(servingBuilds(a.record));
          expect(resolvedFiles(b.importMap, entries)).toEqual(resolvedFiles(a.importMap, entries));
        }
      ));

  it('idempotence: a warm init writes nothing and yields the same map', () =>
    run(4, portfolioArbitrary({ latestSharedExternal: true }), 100, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      const warm = await init.rig.init(init.entries);
      expect(warm.writes).toBe(0);
      expect(warm.importMap).toEqual(init.result.importMap);
      expect(warm.record).toEqual(init.result.record);
    }));

  // Whatever changes in a share scope, the warm init after it re-elects from the state the init left: one
  // external marked dirty must reproduce every pool's record and the files the map gives their specifiers.
  // Half the draws pick an external in no pool when there is one, which re-elects no pool unless a dirty
  // scope re-elects all of them (D-5). Only the pools are compared: determine does not re-resolve every
  // unpooled external the same way once its copies are cached, and under strictExternalCompatibility it may
  // refuse one a cold init took (for-later), hence lenient portfolios.
  it('idempotence: a warm init with any one external dirty reproduces every pool', () =>
    run(
      24,
      fc.tuple(portfolioArbitrary({ latestSharedExternal: true }), fc.boolean(), fc.nat()),
      200,
      async ([spec, unpooled, pick]) => {
        const init = await initOrRefuse(lenient(spec));
        if (!init.ok) return;
        const all = Object.keys(init.result.record).sort();
        const loose = all.filter(name => init.result.record[name]!.poolName === undefined);
        const names = unpooled && loose.length > 0 ? loose : all;
        if (names.length === 0) return;
        const again = await init.rig.touch(names[pick % names.length]!);
        expect(pooledPart(again)).toEqual(pooledPart(init.result));
      }
    ));

  it('the host is never islanded', () =>
    run(
      7,
      portfolioArbitrary().filter(spec => spec.host !== null),
      100,
      async spec => {
        const init = await initOrRefuse(spec);
        if (!init.ok) return;
        const { importMap, record } = init.result;
        const host = init.host!;
        const hostScope = importMap.scopes?.[scopeUrlOf(host)] ?? {};

        for (const members of pools(record).values())
          for (const external of Object.values(members))
            for (const version of external.versions)
              for (const meta of version.remotes) {
                if (meta.name !== host) continue;
                expect(meta.poolCause).toBeUndefined();
                expect(meta.servedBy).toBeUndefined();
                expect(version.action).not.toBe('scope');
                // It runs the global map's files, never a scoped copy of its own pool.
                for (const specifier of Object.keys(meta.entries)) {
                  expect(hostScope[specifier]).toBeUndefined();
                  expect(importMap.imports[specifier]).toBeDefined();
                }
              }
      }
    ));

  // The global map drifting from the view the dynamic gate reads it through would mis-place every load silently.
  it('the committed view of a pool is the global map, specifier for specifier', () =>
    run(8, portfolioArbitrary(), 200, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      const { importMap, record } = init.result;
      for (const [pool, members] of pools(record)) {
        const poolMembers = Object.entries(members).map(([name, external]) => ({ name, external }));
        const { global } = committedView(
          poolMembers,
          copiesByRemote(poolMembers),
          Object.keys(record),
          { shareScope: GLOBAL_SCOPE, packageOf: packageOfIn(record) }
        );
        const view: Record<string, string> = {};
        for (const [specifier, { remote, file }] of global)
          view[specifier] = _path.join(scopeUrlOf(remote), file);
        const imports: Record<string, string> = {};
        for (const copy of copiesOf(members))
          for (const specifier of copy.specifiers)
            if (importMap.imports[specifier] !== undefined)
              imports[specifier] = importMap.imports[specifier];
        expect({ pool, view }).toEqual({ pool, view: imports });
      }
    }));

  // The oracles judge combinations, not ranges: a placement that runs a tag the copy's own range rejects is
  // coherent and untorn, so only this property sees it.
  it('range soundness: every pooled copy runs a tag its own range accepts', () =>
    run(13, portfolioArbitrary(), 250, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      expect(rangeViolations(init.result.importMap, init.result.record)).toEqual([]);
    }));

  it('host invariant: a version marked host has the host first', () =>
    run(11, portfolioArbitrary(), 150, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      for (const [name, external] of Object.entries(init.result.record))
        for (const version of external.versions)
          if (version.host)
            expect({ name, tag: version.tag, first: version.remotes[0]?.name }).toEqual({
              name,
              tag: version.tag,
              first: init.host,
            });
    }));

  it('strict soundness: strictExternalCompatibility refuses only a foreign tag a strict range rejects', () =>
    run(
      12,
      portfolioArbitrary().map(spec => ({ ...spec, strict: true })),
      150,
      async spec => {
        // `initOrRefuse` asserts the soundness of any refusal.
        await initOrRefuse(spec);
      }
    ));
});

/**
 * A warm page after some remotes were redeployed (one to three, each changed and served from a new URL, so it is
 * fetched again and its old copies evicted), over portfolios with label noise (`Relabel`): the changes that
 * split, join or empty a pool. The oracle is the next warm page re-electing every pool of that same state.
 *
 * The partial warm re-elections `pooling.reelection.spec.ts` reproduces failed this: a label
 * change that splits a pool and an eviction that deletes a pool member left a part of the pool clean.
 */
describe('pooling properties: redeploys (generated portfolios)', { timeout: TIMEOUT }, () => {
  it('stored names: every poolWinner and servedBy names a remote that ships the pool', () =>
    run(14, portfolioArbitrary({ labelNoise: true }), 100, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      expect(strayNames(init.result.record)).toEqual([]);
    }));

  // Not a cold page of the final portfolio: cold breaks ties by name where warm keeps the stored winner
  // instead; that is no partial re-election. `outcome` leaves `poolWinner` out, which a stale election keeps
  // when a split pool keeps its name, so the winners are compared too.
  const warmEqualsReelected = async ([spec, redeployed]: [PortfolioSpec, Redeploy[]]) => {
    const rig = openPortfolio({
      host: hostOf(spec),
      latestSharedExternal: spec.latestSharedExternal,
    });
    await rig.init(toRemoteEntries(spec));
    const warm = await rig.init(redeployedEntries(spec, redeployed));
    expect(poolNameDrift(warm.record)).toEqual([]);
    expect(strayNames(warm.record)).toEqual([]);
    const reelected = await rig.reelect();
    const scopeUrls = rig.scopeUrls();
    const settled = (page: typeof warm) => ({
      ...outcome(page.importMap, page.record, scopeUrls),
      winners: Object.fromEntries(
        Object.entries(page.record).map(([name, external]) => [name, external.poolWinner])
      ),
    });
    expect(settled(warm)).toEqual(settled(reelected));
  };

  it('redeploy: a warm init runs and places what re-electing every pool of its state does', () =>
    run(
      16,
      portfolioArbitrary({ maxRemotes: 12, labelNoise: true, latestSharedExternal: true }).chain(
        spec => fc.tuple(fc.constant(lenient(spec)), redeployArbitrary(spec))
      ),
      100,
      warmEqualsReelected
    ));
});

// Shrunk counterexamples the properties found; the bug's explicit guard goes in `pooling.regression.spec.ts`.
describe('pooling properties: shrunk counterexamples', () => {
  // No-tear (binding) with label noise, found by turning `labelNoise`
  // on for the init properties (CI seed).
  // r1 labels its @p0/m0 (only the `/sub` entrypoint, 17.0.1) `p1`, which joins p0 and p1 into one pool
  // whose builds ship its members at different tags. r1 and r2 are islanded `uncovered` for @p0/m0 alone,
  // and both ship @p1/m0 17.0.0-rc.0, which `imports` serves from r1's file. r2 runs its own @p0/m0 17.0.0
  // beside r1's @p1/m0, a file r1's build bound to @p0/m0 17.0.1: a split. Fixed by letting only a build that
  // takes every member it ships from the global map publish a file there.
  it('no-tear (binding): a partly islanded remote does not take a same-tag file from another build', async () => {
    const spec: PortfolioSpec = {
      poolSizes: [5, 3],
      remotes: [
        {
          pools: [
            {
              major: 0,
              minor: 0,
              patch: 0,
              range: 'major',
              members: [null, null, null, null, 'root'],
            },
            { major: 0, minor: 0, patch: 0, range: 'major', members: [null, null, 'root'] },
          ],
          strictVersion: false,
          extra: null,
        },
        {
          pools: [
            {
              major: 0,
              minor: 0,
              patch: 1,
              range: 'major',
              members: ['sub', null, 'root', null, null],
            },
            { major: 0, minor: 0, patch: 0, pre: 0, range: 'major', members: [null, null, null] },
          ],
          strictVersion: false,
          extra: null,
          relabel: { pool: 0, member: 0, to: 1 },
        },
        {
          pools: [
            {
              major: 0,
              minor: 0,
              patch: 0,
              range: 'major',
              members: [null, null, null, null, null],
            },
            { major: 0, minor: 0, patch: 0, pre: 0, range: 'major', members: [null, null, null] },
          ],
          strictVersion: false,
          extra: null,
        },
      ],
      host: null,
      strict: true,
    };
    const entries = toRemoteEntries(spec);
    const init = await openPortfolio({ strict: true }).init(entries);
    const split = poolTears(init.importMap, init.record, scopeUrlsOf(entries)).flatMap(
      t => t.split
    );
    expect(split).toEqual([]);
  });
});
