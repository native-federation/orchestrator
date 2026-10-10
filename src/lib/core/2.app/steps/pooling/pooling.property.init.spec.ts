import fc from 'fast-check';
import type { ImportMap, shareScope } from 'lib/core/1.domain';
import {
  hostOf,
  portfolioArbitrary,
  redeployArbitrary,
  redeployedEntries,
  scopeUrlOf,
  toRemoteEntries,
  type EntryShape,
  type PortfolioSpec,
  type RangeKind,
  type Redeploy,
} from 'lib/testing/pooling/generate-portfolio';
import {
  TIMEOUT,
  accepts,
  copiesOf,
  electedTags,
  initOrRefuse,
  judgeRemote,
  lenient,
  openPortfolio,
  outcome,
  placementOf,
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

  it('idempotence: re-electing every pool on a warm page reproduces the record and the map', () =>
    run(5, portfolioArbitrary({ latestSharedExternal: true }), 200, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      const again = await init.rig.reelect();
      expect(again.importMap).toEqual(init.result.importMap);
      expect(again.record).toEqual(init.result.record);
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

  it('poolCause marks exactly the copies a remote serves itself, off the elected build', () =>
    run(6, portfolioArbitrary(), 125, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      const { importMap, record } = init.result;
      const { runs } = outcome(importMap, record);

      for (const [pool, members] of pools(record)) {
        type Copy = {
          caused: boolean;
          action: string;
          tag: string;
          specifier: string;
          file: string;
        };
        const copies = new Map<string, Copy[]>();
        for (const external of Object.values(members))
          for (const version of external.versions)
            for (const meta of version.remotes)
              for (const [specifier, file] of Object.entries(meta.entries)) {
                if (!copies.has(meta.name)) copies.set(meta.name, []);
                copies.get(meta.name)!.push({
                  caused: meta.poolCause !== undefined,
                  action: version.action,
                  tag: version.tag,
                  specifier,
                  file,
                });
              }

        for (const [remote, shipped] of copies) {
          const partial = shipped.some(c => c.caused) && shipped.some(c => !c.caused);
          for (const copy of shipped) {
            const at = { pool, remote, specifier: copy.specifier };
            // The record: a cause on exactly the copies placed in a `scope` row.
            expect({ ...at, caused: copy.caused }).toEqual({
              ...at,
              caused: copy.action === 'scope',
            });
            // The map: such a copy runs the remote's own file, under its own scope.
            if (copy.caused)
              expect({
                ...at,
                url: importMap.scopes?.[scopeUrlOf(remote)]?.[copy.specifier],
              }).toEqual({
                ...at,
                url: _path.join(scopeUrlOf(remote), copy.file),
              });
            // A remote that self-serves only part of its family takes the elected files for the rest only
            // where they are its own versions (rule 5); anything else would mix two builds.
            else if (partial)
              expect({ ...at, runs: runs[`${remote}|${copy.specifier}`] }).toEqual({
                ...at,
                runs: copy.tag,
              });
          }
        }
      }
    }));

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
          Object.keys(record)
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

  it('cause justified: incompatible only for a rejected elected tag, uncovered only for a gap or no witness', () =>
    run(9, portfolioArbitrary({ latestSharedExternal: true }), 250, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      const { importMap, record } = init.result;
      for (const [pool, members] of pools(record)) {
        const copies = copiesOf(members);
        const elected = electedTags(importMap, copies);
        const remotes = [...new Set(copies.map(c => c.remote))];
        for (const remote of remotes) {
          const { causes } = placementOf(remote, copies);
          if (causes.length === 0) continue;
          const { rejects, missing, witnessed } = judgeRemote(remote, copies, elected, remotes);
          const at = { pool, remote, causes };
          // One election, one reason per remote.
          expect(at).toEqual({ ...at, causes: [causes[0]] });
          if (causes[0] === 'incompatible')
            expect({ ...at, rejects }).toEqual({ ...at, rejects: true });
          else
            expect({ ...at, rejects, gap: missing || !witnessed }).toEqual({
              ...at,
              rejects: false,
              gap: true,
            });
        }
      }
    }));

  it('no needless island: a remote the elected build serves and witnesses is never placed off it', () =>
    run(10, portfolioArbitrary({ latestSharedExternal: true }), 250, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      const { importMap, record } = init.result;
      for (const [pool, members] of pools(record)) {
        const copies = copiesOf(members);
        const elected = electedTags(importMap, copies);
        const remotes = [...new Set(copies.map(c => c.remote))];
        for (const remote of remotes) {
          const { rejects, missing, witnessed } = judgeRemote(remote, copies, elected, remotes);
          if (rejects || missing || !witnessed) continue;
          const { causes, servedBy, servesOthers } = placementOf(remote, copies);
          // The one exception is documented: a subpool's build stays for the other members that need it.
          const keepsSubpool = servedBy.length === 1 && servedBy[0] === remote && servesOthers;
          const at = { pool, remote };
          expect({ ...at, causes, servedBy: keepsSubpool ? [] : servedBy }).toEqual({
            ...at,
            causes: [],
            servedBy: [],
          });
        }
      }
    }));

  // A remote alone serves its family itself, which a subpool whose build serves it would spare. The rounds
  // see to that for the remotes waiting at the time; a remote the publish fixpoint takes off the global map
  // later must find a subpool too, whether it came from one or from round 1 (docs/version-resolver.md
  // §"How pooling resolves", step 4). Without that, it went `uncovered`, and this property failed at offset 19
  // (most generated portfolios demote nobody). The one exception is on purpose (step 2): a lender stays out of
  // a subpool so that its loan keeps a publisher. Restated here as any remote that ships, at the winner's tag of
  // a member, an entrypoint the winner does not list, which spares a few more remotes than the election does.
  // Two known gaps the election still has (backlog) that this stream does not reach: (A) a lender whose loan
  // the fixpoint drops stays alone, as `lenders` is computed once against round 1's coverage; (B) the build of
  // a dissolved subpool stays alone even when a surviving subpool's build serves it.
  it('no stray loner: no remote left alone is served by a final subpool build', () =>
    run(19, portfolioArbitrary({ labelNoise: true }), 125, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      for (const [pool, members] of pools(init.result.record)) {
        const copies = copiesOf(members);
        const remotes = [...new Set(copies.map(c => c.remote))];
        const builds = remotes.filter(r => placementOf(r, copies).servesOthers);
        const winnerCopies = copies.filter(
          c => c.remote === Object.values(members).find(m => m.poolWinner)?.poolWinner
        );
        const lends = (remote: string) =>
          copies.some(
            c =>
              c.remote === remote &&
              c.specifiers.some(
                s =>
                  !winnerCopies.some(w => w.specifiers.includes(s)) &&
                  winnerCopies.some(
                    w => w.tag === c.tag && (w.member === c.member || s.startsWith(`${w.member}/`))
                  )
              )
          );
        // The election's `serves`: the build lists every specifier the remote ships, at a tag its range accepts.
        const serves = (build: string, remote: string) => {
          const tagOf = new Map<string, string>();
          for (const c of copies)
            if (c.remote === build)
              for (const s of c.specifiers) if (!tagOf.has(s)) tagOf.set(s, c.tag);
          return copies
            .filter(c => c.remote === remote)
            .every(c =>
              c.specifiers.every(s => tagOf.has(s) && accepts(tagOf.get(s)!, c.tag, c.range))
            );
        };
        for (const remote of remotes) {
          const { causes, servedBy } = placementOf(remote, copies);
          if (causes.length === 0 || servedBy.length > 0 || lends(remote)) continue;
          const at = { pool, remote };
          expect({ ...at, servedBy: builds.filter(b => serves(b, remote)) }).toEqual({
            ...at,
            servedBy: [],
          });
        }
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
 * The partial warm re-elections `pooling.reelection.spec.ts` reproduces (N3, F3, P1) failed these: a label
 * change that splits a pool (offset 202) and an eviction that deletes a pool member (offsets 45 and 271)
 * left a part of the pool clean. Those offsets stay pinned to the CI stream that found them.
 */
describe('pooling properties: redeploys (generated portfolios)', { timeout: TIMEOUT }, () => {
  // The fixed offsets below replay the stream that found them, so only offset 16 draws the profile flag.
  const redeploys = (latestSharedExternal = false) =>
    portfolioArbitrary({ maxRemotes: 12, labelNoise: true, latestSharedExternal }).chain(spec =>
      fc.tuple(fc.constant(lenient(spec)), redeployArbitrary(spec))
    );

  it('stored names: every poolWinner and servedBy names a remote that ships the pool', () =>
    run(14, portfolioArbitrary({ labelNoise: true }), 100, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      expect(strayNames(init.result.record)).toEqual([]);
    }));

  // Not a cold page of the final portfolio: cold breaks ties by arrival where warm keeps the stored winner
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
    run(16, redeploys(true), 100, warmEqualsReelected));

  // Found at offset 202: a redeploy relabels an external out of its pool; the half that keeps its stored
  // name has no dirty member, so only re-electing every pool of a dirty scope re-elects it.
  it('redeploy: a label change that splits a pool re-elects both halves', () =>
    run(202, redeploys(), 100, warmEqualsReelected, { fixed: true }));

  // Found at offset 271: eviction deletes a pool member and no survivor of the pool lost a copy, so only
  // the sibling marking re-elects them.
  it('redeploy: deleting a pool member re-elects the rest of the pool', () =>
    run(271, redeploys(), 100, warmEqualsReelected, { fixed: true }));

  // Shrunk at offset 45, an eviction rather than P1's label change: r0 wins pool p1, then redeploys without
  // a member only it shipped; eviction deletes that member, nothing left in p1 is dirty, and the warm record
  // keeps `poolWinner: r0` on members r0 no longer ships.
  it('redeploy: every poolWinner and servedBy still names a remote that ships the pool', () =>
    run(
      45,
      redeploys(),
      100,
      async ([spec, redeployed]) => {
        const rig = openPortfolio({ host: hostOf(spec) });
        await rig.init(toRemoteEntries(spec));
        const warm = await rig.init(redeployedEntries(spec, redeployed));
        expect(poolNameDrift(warm.record)).toEqual([]);
        expect(strayNames(warm.record)).toEqual([]);
      },
      { fixed: true }
    ));
});

// Shrunk counterexamples the properties found. Each is `it.fails` until fixed, so vitest reports the fix, then
// stays here as a plain `it`; the bug's explicit guard goes in `pooling.regression.spec.ts`.
describe('pooling properties: shrunk counterexamples', () => {
  const pool = (
    major: number,
    minor: number,
    patch: number,
    members: (EntryShape | null)[],
    range: RangeKind = 'caret'
  ): PortfolioSpec['remotes'][number] => ({
    pools: [{ major, minor, patch, range, members }],
    strictVersion: false,
    extra: null,
  });

  // order independence, found at POOLING_PROPERTY_SEED=1 POOLING_PROPERTY_SCALE=5. The host r0 holds
  // m0@17, so r1 and r2 (two 18.1.1 builds, each with one member the other lacks) both miss round 1, and either
  // can run the subpool that serves r3. They tie on every key, and arrival used to pick whichever registered
  // first: the same tags ran either way, but the stored verdicts (which one is `incompatible`) followed it.
  it('order independence: two equal subpool builds are not told apart by registration order', async () => {
    const spec: PortfolioSpec = {
      poolSizes: [4],
      remotes: [
        pool(0, 0, 0, ['root', null, null, null]),
        pool(1, 1, 1, ['root', 'root', 'root', null]),
        pool(1, 1, 1, ['root', 'root', null, 'root']),
        pool(1, 0, 0, [null, 'root', null, null]),
      ],
      host: 0,
      strict: false,
    };
    const entries = toRemoteEntries(spec);
    const a = await openPortfolio({ host: 'r0' }).init(entries);
    const b = await openPortfolio({ host: 'r0' }).init([0, 2, 1, 3].map(i => entries[i]!));
    expect(outcome(b.importMap, b.record)).toEqual(outcome(a.importMap, a.record));
  });

  // re-election idempotence, found at the CI seed once the generator redeployed builds. r2 and r3 are one
  // 17.1.0 build; round 1 (the host r0) serves neither, and each one's build serves both, so they tie for the
  // subpool. Arrival used to pick: the first election read it from update-cache (r2 first), and r2's subpool
  // dissolved once the extension moved r3 global. The re-election read it from the record pooling rewrote,
  // whose `skip` row (r3) precedes the `scope` row (r2): r3 kept a subpool for r2 and left the global map, so a
  // warm page re-electing on equal terms ran r3 on 17.1.0 instead of 17.1.1.
  it('re-election idempotence: a tie between equal subpool builds does not flip on re-election', async () => {
    const spec: PortfolioSpec = {
      poolSizes: [3],
      remotes: [
        pool(0, 1, 1, ['root', null, 'root'], 'major'),
        pool(0, 1, 1, [null, 'root', 'sub'], 'major'),
        pool(0, 1, 0, [null, 'root', 'root'], 'drift'),
        pool(0, 1, 0, [null, 'root', 'root'], 'major'),
      ],
      host: 0,
      strict: false,
    };
    const rig = openPortfolio({ host: 'r0' });
    const init = await rig.init(toRemoteEntries(spec));
    const again = await rig.reelect();
    expect(again.importMap).toEqual(init.importMap);
    expect(again.record).toEqual(init.record);
  });

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
    // A strict refusal places nothing, so it cannot tear.
    const init = await openPortfolio({ strict: true })
      .init(entries)
      .catch(() => undefined);
    if (!init) return;
    const split = poolTears(init.importMap, init.record, scopeUrlsOf(entries)).flatMap(
      t => t.split
    );
    expect(split).toEqual([]);
  });
});
