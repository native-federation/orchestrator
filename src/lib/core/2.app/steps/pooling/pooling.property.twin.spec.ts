import fc from 'fast-check';
import { portfolioArbitrary, type PortfolioSpec } from 'lib/testing/pooling/generate-portfolio';
import { TIMEOUT, lenient, run } from 'lib/testing/pooling/property-harness';
import { twinGate } from 'lib/testing/pooling/twin';

/**
 * Dynamic pooling is global-or-self: a runtime remote resolves through the committed global map or serves its
 * whole pool family itself. Checked by loading a twin (a renamed clone of a committed remote) and holding it
 * against its source's placement at init; the oracle and its checks are in `lib/testing/pooling/twin.ts`.
 */

const twinArbitrary = (o: Parameters<typeof portfolioArbitrary>[0]) =>
  portfolioArbitrary(o)
    .filter(spec => spec.remotes.length > 0)
    .chain(spec => fc.tuple(fc.constant(lenient(spec)), fc.nat(spec.remotes.length - 1)));

const twinGates = async ([spec, source]: [PortfolioSpec, number]) => {
  const { R, T, reds } = await twinGate(spec, source);
  expect({ R, T, reds }).toEqual({ R, T, reds: [] });
};

describe('pooling properties: twin loads (generated portfolios)', { timeout: TIMEOUT }, () => {
  it('twin: a renamed clone of a committed remote resolves through the map or serves itself', () =>
    run(
      111,
      twinArbitrary({
        maxRemotes: 12,
        labelNoise: true,
        latestSharedExternal: true,
        scopeUncoveredEntrypoints: true,
      }),
      150,
      twinGates
    ));

  for (const [offset, shareScope] of [
    [112, undefined],
    [113, 'team'],
  ] as const)
    it(`twin with flat and dense builds in one pool, ${shareScope ?? 'global'} share scope`, () =>
      run(
        offset,
        twinArbitrary({
          maxRemotes: 12,
          labelNoise: true,
          flat: true,
          ...(shareScope && { shareScope }),
        }),
        150,
        twinGates
      ));

  // Flat builds ship each entrypoint as a package of its own, which the map can still serve where the shared
  // version lacks it.
  for (const [offset, shareScope] of [
    [114, undefined],
    [115, 'team'],
  ] as const)
    it(`twin with flat and dense builds under scopeUncoveredEntrypoints, ${shareScope ?? 'global'} share scope`, () =>
      run(
        offset,
        twinArbitrary({
          maxRemotes: 12,
          labelNoise: true,
          flat: true,
          scopeUncoveredEntrypoints: true,
          ...(shareScope && { shareScope }),
        }),
        150,
        twinGates
      ));
});

describe('pooling properties: twin counterexamples', () => {
  const remote = (
    flat: boolean,
    pool: {
      major: number;
      minor: number;
      patch: number;
      members: (string | null)[];
      range: string;
    },
    extraRange: 'caret' | 'tilde' = 'tilde'
  ) => ({ pools: [pool], strictVersion: false, extra: null, extraRange, relabel: null, flat });

  // Reduced from 'subpool' reds at seeds 1–4 (tester-9). r0 and r1 ship @p0/m0/sub at 17.0.1 under ^17
  // ranges; the host r2 publishes 18.0.1 for the whole pool. Init keeps r0's build as a subpool for r0 and r1
  // (servedBy r0). A clone of r0 loaded at runtime fits that subpool, but it rejects the map's 18.0.1, so
  // global-or-self has it serve its own family.
  it('a runtime remote fitting a committed subpool self-serves', async () => {
    const sub = (major: number, range: string, members: (string | null)[]) =>
      remote(false, { major, minor: 0, patch: 1, members, range });
    const spec = {
      poolSizes: [2],
      strict: false,
      host: 2,
      remotes: [
        sub(0, 'major', ['sub', null]),
        sub(0, 'caret', ['sub', null]),
        sub(1, 'exact', ['root', 'sub']),
      ],
    } as unknown as PortfolioSpec;
    expect((await twinGate(spec, 0)).reds).toEqual([]);
  });

  // fx-sf-global (tester-9). r0 is a flat 18.0.0 build (@p0/m1 and @p0/m1/sub each a package of its own);
  // r1 a dense 18.2.0 build shipping only @p0/m1/sub under ^18. At init r1 skips onto the map, which serves
  // @p0/m1/sub from r0. Under scopeUncoveredEntrypoints the resolver scopes a clone of r1 (the shared
  // @p0/m1 18.2.0 lacks /sub); the gate judges it all the same, and the map serves it as it serves r1.
  const m1 = (flat: boolean, minor: number, members: (string | null)[]) =>
    remote(flat, { major: 1, minor, patch: 0, members, range: 'major' }, 'caret');
  const sfGlobal = {
    poolSizes: [3],
    strict: false,
    host: null,
    scopeUncoveredEntrypoints: true,
    remotes: [m1(true, 0, [null, 'root+sub', null]), m1(false, 2, [null, 'sub', null])],
  } as unknown as PortfolioSpec;

  it('a runtime remote the resolver scopes for an entrypoint the map serves resolves through the map', async () => {
    const { T, reds, record } = await twinGate(sfGlobal, 1);
    expect(reds).toEqual([]);
    const twin = record!['@p0/m1']!.versions.find(v => v.remotes.some(r => r.name === T))!;
    expect(twin.action).not.toBe('scope');
    expect(twin.remotes.find(r => r.name === T)!.poolCause).toBeUndefined();
  });
});
