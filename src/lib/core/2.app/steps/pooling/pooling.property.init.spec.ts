import fc from 'fast-check';
import { GLOBAL_SCOPE, type ImportMap, type shareScope } from 'lib/core/1.domain';
import {
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
  unmapped,
} from 'lib/testing/pooling/property-harness';
import * as _path from 'lib/utils/path';
import { copiesByRemote } from 'lib/core/1.domain/pooling/builds';
import { committedView } from 'lib/core/1.domain/pooling/gate';

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

describe('pooling properties: init (generated portfolios)', { timeout: TIMEOUT }, () => {
  // The two oracles run as separate properties, so a failure names which of them broke.
  it('no-tear (resolution): no remote resolves a combination no build shipped', () =>
    run(
      1,
      portfolioArbitrary({ latestSharedExternal: true, scopeUncoveredEntrypoints: true }),
      150,
      async spec => {
        const init = await initOrRefuse(spec);
        if (!init.ok) return;
        const { importMap, record } = init.result;
        for (const tear of poolTears(importMap, record, scopeUrlsOf(init.entries), init.host))
          expect({ pool: tear.pool, incoherent: tear.incoherent }).toEqual({
            pool: tear.pool,
            incoherent: [],
          });
        // The oracle skips a specifier the map does not resolve. Under scopeUncoveredEntrypoints the builders
        // drop an uncovered entrypoint instead of self-filling it, so a torn skip copy would leave it unmapped:
        // nothing may be left so.
        if (spec.scopeUncoveredEntrypoints)
          expect(unmapped(outcome(importMap, record, scopeUrlsOf(init.entries)).runs)).toEqual([]);
      }
    ));

  it('no-tear (binding): no file a remote reaches binds a second tag of any specifier', () =>
    run(
      2,
      portfolioArbitrary({
        labelNoise: true,
        latestSharedExternal: true,
        scopeUncoveredEntrypoints: true,
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
  for (const [offset, shareScope] of [
    [20, undefined],
    [21, 'team'],
  ] as const)
    it(`no-tear with flat and dense builds in one pool, ${shareScope ?? 'global'} share scope`, () =>
      run(
        offset,
        portfolioArbitrary({ flat: true, labelNoise: true, ...(shareScope && { shareScope }) }),
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
          copiesByRemote(poolMembers, () => false),
          Object.keys(record),
          { shareScope: GLOBAL_SCOPE }
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
 * The partial warm re-elections `pooling.reelection.spec.ts` reproduces (N3, F3, P1) failed this: a label
 * change that splits a pool and an eviction that deletes a pool member left a part of the pool clean.
 */
describe('pooling properties: redeploys (generated portfolios)', { timeout: TIMEOUT }, () => {
  it('stored names: every poolWinner and servedBy names a remote that ships the pool', () =>
    run(14, portfolioArbitrary({ labelNoise: true }), 100, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      expect(strayNames(init.result.record)).toEqual([]);
    }));

  // Not a cold page of the final portfolio: cold breaks ties by record order where warm keeps the stored winner
  // instead; that is no partial re-election. `outcome` leaves `poolWinner` out, which a stale election keeps
  // (P1), so the winners are compared too.
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
