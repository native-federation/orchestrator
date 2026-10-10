import fc from 'fast-check';
import { NFError } from 'lib/core/native-federation.error';
import {
  extraRemoteArbitrary,
  extraRemotesArbitrary,
  hostOf,
  portfolioArbitrary,
  toRemoteEntries,
  toRemoteEntry,
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
  pools,
  rangeViolations,
  run,
  scopeUrlsOf,
  torn,
  unmapped,
} from 'lib/testing/pooling/property-harness';

/**
 * Pooling invariants of the dynamic path (`initRemoteEntry`) over generated portfolios: an init, then one or
 * two loads, each a clone of a remote, a clone with one change or a fresh remote. See
 * `pooling.property.init.spec.ts` for the generator and the seeds.
 */

describe('pooling properties: dynamic loads (generated portfolios)', { timeout: TIMEOUT }, () => {
  // Whether the committed map tears is the init property's question; this one asks that the delta adds no tear
  // of its own, so an init tear cannot mask a dynamic one.
  it('dynamic additivity: the delta never re-declares a committed key and adds no tear', () =>
    run(
      101,
      portfolioArbitrary({
        maxRemotes: 12,
        labelNoise: true,
        scopeUncoveredEntrypoints: true,
      }).chain(spec => fc.tuple(fc.constant(lenient(spec)), extraRemotesArbitrary(spec))),
      150,
      async ([spec, extras]) => {
        const entries = toRemoteEntries(spec);
        const host = hostOf(spec);
        const rig = openPortfolio({
          host,
          scopeUncoveredEntrypoints: spec.scopeUncoveredEntrypoints,
        });
        let committed = (await rig.init(entries)).importMap;
        const loaded = [...entries];

        // One page per load: each load's committed map is what the previous one left merged.
        for (const extra of extras) {
          const added = toRemoteEntry(extra, loaded.length);
          const { delta, merged, record } = await rig.load(added);

          for (const key of Object.keys(delta.imports))
            expect({ key, committed: key in committed.imports }).toEqual({ key, committed: false });
          for (const key of Object.keys(delta.scopes ?? {}))
            expect({ key, committed: key in (committed.scopes ?? {}) }).toEqual({
              key,
              committed: false,
            });

          // Both sides judged under the pools as they stand after the load: a remote can join a pool that did
          // not exist at init (a lone labelled external gains its sibling), and the committed map it then
          // exposes is immutable, so a tear already in it is not the delta's.
          const before = torn(committed, record, scopeUrlsOf(loaded), host);
          loaded.push(added);
          const after = torn(merged, record, scopeUrlsOf(loaded), host);
          expect(after.filter(t => !before.includes(t))).toEqual([]);
          if (spec.scopeUncoveredEntrypoints)
            expect(
              unmapped(outcome(merged, record, scopeUrlsOf(loaded)).runs).filter(k =>
                k.startsWith(`${added.name}|`)
              )
            ).toEqual([]);
          committed = merged;
        }
      }
    ));

  // 101 with flat and dense builds in one pool: a specifier can be an entry of the loaded remote's package
  // and a package of its own in the committed map, so what serves the load is read per specifier, not per
  // external. In a named share scope the load maps in its own scope, with no `imports` to inherit.
  for (const [offset, shareScope] of [
    [107, undefined],
    [108, 'team'],
  ] as const)
    it(`dynamic additivity with flat and dense builds in one pool, ${shareScope ?? 'global'} share scope`, () =>
      run(
        offset,
        portfolioArbitrary({
          maxRemotes: 12,
          labelNoise: true,
          flat: true,
          ...(shareScope && { shareScope }),
        }).chain(spec => fc.tuple(fc.constant(lenient(spec)), extraRemotesArbitrary(spec))),
        150,
        async ([spec, extras]) => {
          const entries = toRemoteEntries(spec);
          const host = hostOf(spec);
          const rig = openPortfolio({ host, ...(shareScope && { scope: shareScope }) });
          let committed = (await rig.init(entries)).importMap;
          const loaded = [...entries];

          for (const extra of extras) {
            const added = toRemoteEntry(extra, loaded.length, 0, shareScope);
            const { delta, merged, record } = await rig.load(added);

            for (const key of Object.keys(delta.imports))
              expect({ key, committed: key in committed.imports }).toEqual({
                key,
                committed: false,
              });
            for (const [scope, imports] of Object.entries(delta.scopes ?? {}))
              for (const key of Object.keys(imports))
                expect({
                  scope,
                  key,
                  committed: key in (committed.scopes?.[scope] ?? {}),
                }).toEqual({ scope, key, committed: false });

            const before = torn(committed, record, scopeUrlsOf(loaded), host, shareScope);
            loaded.push(added);
            const after = torn(merged, record, scopeUrlsOf(loaded), host, shareScope);
            expect(after.filter(t => !before.includes(t))).toEqual([]);
            committed = merged;
          }
        }
      ));

  // The record a load leaves is what the next page rebuilds its map from, so it must rebuild the page the
  // load handed the browser. Compared as the tag each remote runs per specifier, since which of two copies of
  // one tag publishes a file is record order.
  it('dynamic reload: a warm init after a load runs the tags the page ran', () =>
    run(
      102,
      portfolioArbitrary({ maxRemotes: 12 }).chain(spec =>
        fc.tuple(fc.constant(lenient(spec)), extraRemoteArbitrary(spec))
      ),
      150,
      async ([spec, extra]) => {
        const entries = toRemoteEntries(spec);
        const rig = openPortfolio({ host: hostOf(spec) });
        await rig.init(entries);
        const added = toRemoteEntry(extra, entries.length);
        const { merged, record } = await rig.load(added);
        const warm = await rig.init([...entries, added]);
        expect(outcome(warm.importMap, warm.record).runs).toEqual(outcome(merged, record).runs);
      }
    ));

  // 102 under label noise, the relabels that split and join pools, with the stored names checked on both
  // pages: a load writes the name of every pool as it now stands (a merge renames committed members), and
  // the next init leaves no stale name. Between the two, an external in no pool may keep its old name.
  it('dynamic reload with label noise: pool names stay in sync and the warm init runs the page', () =>
    run(
      106,
      portfolioArbitrary({ maxRemotes: 12, labelNoise: true }).chain(spec =>
        fc.tuple(fc.constant(lenient(spec)), extraRemoteArbitrary(spec))
      ),
      150,
      async ([spec, extra]) => {
        const entries = toRemoteEntries(spec);
        const rig = openPortfolio({ host: hostOf(spec) });
        await rig.init(entries);
        const added = toRemoteEntry(extra, entries.length);
        const { merged, record } = await rig.load(added);
        expect(poolNameDrift(record, { pooledOnly: true })).toEqual([]);
        const warm = await rig.init([...entries, added]);
        expect(poolNameDrift(warm.record)).toEqual([]);
        expect(outcome(warm.importMap, warm.record).runs).toEqual(outcome(merged, record).runs);
      }
    ));

  // 102 with flat and dense builds in one pool: the record a load leaves must not let a copy that ran the
  // map's files claim a specifier on the next page.
  for (const [offset, shareScope] of [
    [109, undefined],
    [110, 'team'],
  ] as const)
    it(`dynamic reload with flat and dense builds in one pool, ${shareScope ?? 'global'} share scope`, () =>
      run(
        offset,
        portfolioArbitrary({
          maxRemotes: 12,
          labelNoise: true,
          flat: true,
          ...(shareScope && { shareScope }),
        }).chain(spec => fc.tuple(fc.constant(lenient(spec)), extraRemoteArbitrary(spec))),
        150,
        async ([spec, extra]) => {
          const entries = toRemoteEntries(spec);
          const rig = openPortfolio({
            host: hostOf(spec),
            ...(shareScope && { scope: shareScope }),
          });
          await rig.init(entries);
          const added = toRemoteEntry(extra, entries.length, 0, shareScope);
          const { merged, record } = await rig.load(added);
          const warm = await rig.init([...entries, added]);
          expect(outcome(warm.importMap, warm.record).runs).toEqual(outcome(merged, record).runs);
        }
      ));

  // The gate's rules against a committed map (docs/version-resolver.md §"Scope and dynamic init"): a range
  // rejecting a committed tag is `incompatible`; otherwise the remote resolves globally when it agrees with the
  // map, or when the map serves all of it and a committed build shipped that combination.
  it('dynamic verdicts: a load is placed off the committed map only for a reason, and the right one', () =>
    run(
      103,
      portfolioArbitrary({ maxRemotes: 12 }).chain(spec =>
        fc.tuple(fc.constant(lenient(spec)), extraRemoteArbitrary(spec))
      ),
      150,
      async ([spec, extra]) => {
        const entries = toRemoteEntries(spec);
        const rig = openPortfolio({ host: hostOf(spec) });
        const { importMap: committed } = await rig.init(entries);
        const added = toRemoteEntry(extra, entries.length);
        const { record } = await rig.load(added);

        for (const [pool, members] of pools(record)) {
          const copies = copiesOf(members);
          if (!copies.some(c => c.remote === added.name)) continue;
          const elected = electedTags(committed, copies);
          const builds = [...new Set(copies.map(c => c.remote))].filter(r => r !== added.name);
          const { rejects, missing, witnessed, agrees } = judgeRemote(
            added.name,
            copies,
            elected,
            builds
          );
          const { causes, servedBy } = placementOf(added.name, copies);
          const at = { pool, causes, servedBy };
          const global = !rejects && (agrees || (!missing && witnessed));
          // Off the map, it serves its whole family itself: never a committed build.
          const cause = rejects ? 'incompatible' : 'uncovered';
          expect(at).toEqual({ ...at, causes: global ? [] : [cause], servedBy: [] });
        }
      }
    ));

  // A load lands globally or in its own scope; either way each specifier it ships must run a tag its own range
  // accepts.
  it('dynamic range soundness: every loaded copy runs a tag its own range accepts', () =>
    run(
      105,
      portfolioArbitrary({ maxRemotes: 12 }).chain(spec =>
        fc.tuple(fc.constant(lenient(spec)), extraRemotesArbitrary(spec))
      ),
      150,
      async ([spec, extras]) => {
        const entries = toRemoteEntries(spec);
        const rig = openPortfolio({ host: hostOf(spec) });
        await rig.init(entries);
        let index = entries.length;
        for (const extra of extras) {
          const added = toRemoteEntry(extra, index++);
          const { merged, record } = await rig.load(added);
          expect(rangeViolations(merged, record, added.name)).toEqual([]);
        }
      }
    ));

  // Under strict a load can be refused by the resolver: only for a strict range that rejects the tag the
  // committed record shares, never its own. A load that goes through is as additive as a lenient one.
  it('dynamic under strict: a load is refused only for a rejected shared tag, and is additive otherwise', () =>
    run(
      104,
      portfolioArbitrary({ maxRemotes: 12 }).chain(spec =>
        fc.tuple(fc.constant({ ...spec, strict: true }), extraRemotesArbitrary(spec))
      ),
      150,
      async ([spec, extras]) => {
        const init = await initOrRefuse(spec);
        if (!init.ok) return;
        const host = init.host;
        const loaded = [...init.entries];
        let committed = init.result.importMap;
        let before = init.result.record;

        for (const extra of extras) {
          const added = toRemoteEntry(extra, loaded.length);
          let load: Awaited<ReturnType<typeof init.rig.load>>;
          try {
            load = await init.rig.load(added);
          } catch (error) {
            expect(error).toBeInstanceOf(NFError);
            expect((error as Error).message).toBe(`Could not process remote '${added.name}'`);
            const sound = added.shared.some(s => {
              const shared = before[s.packageName]?.versions.find(v => v.action === 'share');
              return (
                s.singleton &&
                s.strictVersion &&
                shared !== undefined &&
                !accepts(shared.tag, s.version!, s.requiredVersion)
              );
            });
            expect({ remote: added.name, sound }).toEqual({ remote: added.name, sound: true });
            return;
          }

          const { delta, merged, record } = load;
          for (const key of Object.keys(delta.imports))
            expect({ key, committed: key in committed.imports }).toEqual({ key, committed: false });
          const tornBefore = torn(committed, record, scopeUrlsOf(loaded), host);
          loaded.push(added);
          const tornAfter = torn(merged, record, scopeUrlsOf(loaded), host);
          expect(tornAfter.filter(t => !tornBefore.includes(t))).toEqual([]);
          committed = merged;
          before = record;
        }
      }
    ));
});
