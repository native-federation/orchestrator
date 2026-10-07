import fc from 'fast-check';
import {
  hostOf,
  portfolioArbitrary,
  scopeUrlOf,
  toRemoteEntries,
  type EntryShape,
  type PortfolioSpec,
  type RangeKind,
} from 'lib/testing/pooling/generate-portfolio';
import {
  TIMEOUT,
  copiesOf,
  electedTags,
  initOrRefuse,
  judgeRemote,
  lenient,
  openPortfolio,
  outcome,
  placementOf,
  poolTears,
  pools,
  rangeViolations,
  run,
  scopeUrlsOf,
} from 'lib/testing/pooling/property-harness';
import * as _path from 'lib/utils/path';
import { committedView } from 'lib/core/1.domain/pooling/views';

/**
 * Pooling invariants over generated portfolios (`generate-portfolio.ts`), through the real init steps with
 * real semver; the dynamic path is `pooling.property.dynamic.spec.ts`. Each property runs its own fixed seed,
 * so a failure reproduces; fast-check prints the shrunk spec. A counterexample found here belongs in the
 * regression section at the bottom.
 *
 * The generator covers 1-20 remotes, 1-3 pools of 2-6 members with 2-4 builds each that remotes redeploy
 * (plus one-off stragglers), two majors x three minors (plus patches and rare prereleases), `^`/`~`/exact
 * ranges, `^<major>.0.0` and "drifted" ranges that exclude the remote's own tag, ragged member and entrypoint
 * sets, an optional host, and `strictVersion` / `strictExternalCompatibility` on or off.
 *
 * A deeper local search: POOLING_PROPERTY_SEED=<n> POOLING_PROPERTY_SCALE=<factor> (CI uses the defaults).
 */

describe('pooling properties: init (generated portfolios)', { timeout: TIMEOUT }, () => {
  // The two oracles run as separate properties, so a failure names which of them broke.
  it('no-tear (resolution): no remote resolves a combination no build shipped', () =>
    run(1, portfolioArbitrary(), 150, async spec => {
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
    run(2, portfolioArbitrary(), 300, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      const { importMap, record } = init.result;
      for (const tear of poolTears(importMap, record, scopeUrlsOf(init.entries), init.host))
        expect({ pool: tear.pool, split: tear.split }).toEqual({ pool: tear.pool, split: [] });
    }));

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
    run(4, portfolioArbitrary(), 200, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      const warm = await init.rig.init(init.entries);
      expect(warm.writes).toBe(0);
      expect(warm.importMap).toEqual(init.result.importMap);
      expect(warm.record).toEqual(init.result.record);
    }));

  // Offset 5 reaches the re-election flip pinned at the bottom (D10); it moves back once D10 lands.
  it('idempotence: re-electing every pool on a warm page reproduces the record and the map', () =>
    run(13, portfolioArbitrary(), 200, async spec => {
      const init = await initOrRefuse(spec);
      if (!init.ok) return;
      const again = await init.rig.reelect();
      expect(again.importMap).toEqual(init.result.importMap);
      expect(again.record).toEqual(init.result.record);
    }));

  it('poolCause marks exactly the copies a remote serves itself, off the elected build', () =>
    run(6, portfolioArbitrary(), 250, async spec => {
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
      200,
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
        const { global } = committedView(
          Object.entries(members).map(([name, external]) => ({ name, external }))
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
    run(9, portfolioArbitrary(), 250, async spec => {
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
    run(10, portfolioArbitrary(), 250, async spec => {
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
      300,
      async spec => {
        // `initOrRefuse` asserts the soundness of any refusal.
        await initOrRefuse(spec);
      }
    ));
});

// Shrunk counterexamples the properties found on the current code. Each is `it.fails` until fixed: once a fix
// lands it starts passing, vitest reports it, and it moves into the regression suite as a plain `it`.
describe('pooling properties: known counterexamples', () => {
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

  // order independence, found at POOLING_PROPERTY_SEED=1 POOLING_PROPERTY_SCALE=5. The host r0 holds m0@17,
  // so r1 and r2 (two 18.1.1 builds, each with one member the other lacks) both miss round 1, and either can run
  // the subpool that serves r3. They tie on every key and `byArrival` picks whichever registered first: the
  // same tags run either way, but the stored verdicts (which one is `incompatible`) follow registration order.
  it.fails(
    'order independence: two equal subpool builds are told apart by registration order',
    async () => {
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
    }
  );

  // re-election idempotence, found at the CI seed once the generator redeployed builds (D10 again). r2 and r3
  // are one 17.1.0 build; round 1 (the host r0) serves neither, and each one's build serves both, so they tie
  // for the subpool and `byArrival` picks. The first election reads arrival from update-cache (r2 first): r2's
  // subpool dissolves once the extension moves r3 global. The re-election reads it from the record pooling
  // rewrote, whose `skip` row (r3) precedes the `scope` row (r2): r3 keeps a subpool for r2 and leaves the global
  // map, so a warm page re-electing on equal terms runs r3 on 17.1.0 instead of 17.1.1.
  it.fails(
    're-election idempotence: a tie between equal subpool builds flips on re-election',
    async () => {
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
    }
  );
});
