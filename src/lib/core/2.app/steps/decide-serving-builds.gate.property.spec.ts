import fc from 'fast-check';
import { GLOBAL_SCOPE, type ImportMap, type RemoteEntry } from 'lib/core/1.domain';
import {
  extraRemoteArbitrary,
  hostOf,
  portfolioArbitrary,
  redeployArbitrary,
  redeployedEntries,
  toRemoteEntries,
  toRemoteEntry,
  type PortfolioSpec,
  type Redeploy,
  type RemoteSpec,
} from 'lib/testing/pooling/generate-portfolio';
import { TIMEOUT, run } from 'lib/testing/pooling/property-harness';
import { portfolio } from 'lib/testing/pooling/portfolio';
import { createStorageConfig } from 'lib/core/4.config/storage/storage.config';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';

/**
 * The serving-build step decides only the share scopes something wrote: this init before deciding, or a runtime
 * load since the last decide. This holds that gate to a reference that decides every scope on every init
 * (`decideEveryScope`, a test-only adapter): over the same page sequence, both must store the same state, install
 * the same maps and refuse the same pages.
 *
 * Each sequence starts cold and ends with two warm inits, so the first warm init after the cold one, and the
 * inits after runtime loads, are always compared. Between them: runtime loads (on the page, or on a reloaded page
 * with no init of its own), redeploys to a new URL (eviction, a dropped package), `touch`, `reelect`, and an
 * upgrade: a startup that finds `cache-state` missing or stamped by another version. Portfolios
 * draw strict or not, a host, flat and chunked builds, label noise, `latestSharedExternal`, and remotes in the
 * global and a named share scope side by side. `portfolio()` also checks after every commit that storage holds
 * the record the page holds, which a write the gate skipped would break.
 */

type Step =
  | { kind: 'warm' }
  | { kind: 'load'; remote: RemoteSpec; reload: boolean }
  | { kind: 'redeploy'; redeploys: Redeploy[] }
  | { kind: 'touch'; pick: number }
  | { kind: 'reelect' }
  | { kind: 'upgrade'; stamp: string | null };

const stepsArbitrary = (spec: PortfolioSpec): fc.Arbitrary<Step[]> =>
  fc.array(
    fc.oneof(
      { arbitrary: fc.constant<Step>({ kind: 'warm' }), weight: 2 },
      {
        arbitrary: fc
          .record({ remote: extraRemoteArbitrary(spec), reload: fc.boolean() })
          .map(load => ({ kind: 'load' as const, ...load })),
        weight: 4,
      },
      {
        arbitrary: redeployArbitrary(spec).map(redeploys => ({
          kind: 'redeploy' as const,
          redeploys,
        })),
        weight: 2,
      },
      { arbitrary: fc.nat().map(pick => ({ kind: 'touch' as const, pick })), weight: 1 },
      { arbitrary: fc.constant<Step>({ kind: 'reelect' }), weight: 1 },
      {
        arbitrary: fc
          .constantFrom<string | null>(null, '0.0.1')
          .map(stamp => ({ kind: 'upgrade' as const, stamp })),
        weight: 1,
      }
    ),
    { maxLength: 5 }
  );

let namespaces = 0;
let refusedLoads = 0;

// One page sequence on one rig. Every page but the first opens over what the last one committed.
function rigFor(spec: PortfolioSpec, decideEveryScope: boolean) {
  const storage = `nf-decide-gate-${namespaces++}`;
  const host = hostOf(spec);
  const p = portfolio(
    {},
    {
      hosts: host === undefined ? [] : [host],
      strict: spec.strict,
      latestSharedExternal: spec.latestSharedExternal,
      storage,
      realRepositories: true,
      assertNoTear: false,
      decideEveryScope,
    }
  );
  let fresh = true;
  const next = () => {
    if (!fresh) p.reload();
    fresh = false;
  };
  const page = async (step: () => Promise<ImportMap>) => {
    try {
      const importMap = await step();
      return {
        importMap,
        stored: structuredClone((globalThis as unknown as Record<string, unknown>)[storage]),
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };

  return {
    init: (entries: RemoteEntry[]) => page(() => (next(), p.runInit(entries))),
    load: (entry: RemoteEntry, reload: boolean) =>
      page(async () => {
        if (reload) next();
        fresh = false;
        return (await p.runDynamic(structuredClone(entry))).importMap;
      }),
    touch: (pick: number) =>
      page(() => {
        next();
        const names = Object.keys(p.stored()).sort();
        return names.length === 0 ? p.runInit() : p.touch(names[pick % names.length]!);
      }),
    reelect: () => page(() => (next(), p.reelect())),
    // A startup that finds the cache stamped by another version, or not at all, drops it; the init refetches
    // every remote.
    upgrade: (entries: RemoteEntry[], stamp: string | null) =>
      page(() => {
        const namespace = (globalThis as unknown as Record<string, Record<string, unknown>>)[
          storage
        ]!;
        if (stamp === null) delete namespace['cache-state'];
        else namespace['cache-state'] = { ...(namespace['cache-state'] as object), version: stamp };
        const { clearStorage } = createStorageConfig({
          storage: globalThisStorageEntry,
          storageNamespace: storage,
          exposeStorageGetter: false,
        });
        expect(clearStorage).toBe(true);
        p.reload(true);
        fresh = false;
        return p.runInit(entries);
      }),
  };
}

describe('decide gate: deciding only what changed', { timeout: TIMEOUT * 2 }, () => {
  it('stores, maps and refuses what deciding every scope on every init does', async () => {
    await run(
      601,
      portfolioArbitrary({
        maxRemotes: 8,
        labelNoise: true,
        flat: true,
        chunks: true,
        latestSharedExternal: true,
        mixedScope: 'team',
      }).chain(spec => fc.tuple(fc.constant(spec), stepsArbitrary(spec))),
      150,
      async ([spec, steps]) => {
        const gated = rigFor(spec, false);
        const reference = rigFor(spec, true);
        let entries = toRemoteEntries(spec);
        const loaded: RemoteEntry[] = [];
        const both = async <T>(step: (rig: ReturnType<typeof rigFor>) => Promise<T>) => {
          const [a, b] = [await step(gated), await step(reference)];
          expect(a).toEqual(b);
          return !(a as { error?: string }).error;
        };

        if (!(await both(rig => rig.init(entries)))) return;
        for (const step of [...steps, { kind: 'warm' } as const, { kind: 'warm' } as const]) {
          let ok: boolean;
          switch (step.kind) {
            case 'warm':
              ok = await both(rig => rig.init([...entries, ...loaded]));
              break;
            case 'load': {
              const entry = toRemoteEntry(step.remote, spec.remotes.length + loaded.length);
              loaded.push(entry);
              ok = await both(rig => rig.load(entry, step.reload));
              break;
            }
            case 'redeploy':
              entries = redeployedEntries(spec, step.redeploys);
              ok = await both(rig => rig.init([...entries, ...loaded]));
              break;
            case 'touch':
              ok = await both(rig => rig.touch(step.pick));
              break;
            case 'upgrade':
              ok = await both(rig => rig.upgrade([...entries, ...loaded], step.stamp));
              break;
            case 'reelect':
              ok = await both(rig => rig.reelect());
              break;
          }
          // A refused load is rolled back, so the next page opens over the committed state. A refused init
          // commits nothing and `reload` would commit it: the sequence ends there.
          if (!ok && step.kind !== 'load') return;
          if (!ok) refusedLoads++;
        }
      }
    );
    // The pages after a refused load ran too, compared like any other.
    expect(refusedLoads).toBeGreaterThan(0);
  });

  // Without this the property could pass on portfolios that never put a remote in the named scope.
  it('draws remotes into both share scopes', () => {
    const specs = fc.sample(portfolioArbitrary({ mixedScope: 'team' }), { numRuns: 50, seed: 601 });
    const scopes = new Set(
      specs.flatMap(spec => spec.remotes.map(remote => remote.shareScope ?? GLOBAL_SCOPE))
    );
    expect([...scopes].sort()).toEqual([GLOBAL_SCOPE, 'team'].sort());
  });
});
