import { test, expect, storedActions } from '../harness/federation';
import { dep, remote, SCOPE } from '../harness/portfolio';

/**
 * Entrypoint coverage: which build serves a package whose remotes declare *different subsets* of its
 * entrypoints.
 *
 * Real-world regression (issue #61): three remotes shared `@angular/material@22.0.6`, but only one
 * bundled the `/sort` entrypoint. Serving `/table` from one build and `/sort` from another tears the
 * package — the same hazard as two members of a family from two builds, one level down. So the resolver
 * elects the *widest* remote as the serving basis (`versions[0].remotes[0]`) and, when no single remote
 * covers everything, fills the remainder from a sibling that declares it.
 *
 * mfe1 and mfe2 stand in for the two narrow production remotes, mfe3 for the one bundling `/sort`.
 * What the browser ends up *running* is the part a step-level guard cannot check: self-fill keeps the
 * map resolvable but does put two builds of one package on the page, and `nf.buildsOf` says so.
 *
 * **This is a resolver policy, not a pooling one.** Coverage is decided per external in `determine`
 * and `generate-import-map`; the portfolios below hold a single external, so its pool has one member
 * and the gates have nothing to coordinate. Every case here behaves identically with
 * `useAutoExternalPooling` off, which `flag.e2e.spec.ts` pins — it matters because self-fill makes one
 * remote draw a package from two builds, the very shape gate 2 reacts to when the builds belong to a
 * *family*. What happens when the ragged package belongs to a family whose remote is islanded is in
 * `asymmetric.e2e.spec.ts`; how the same subsets look in the flat remoteEntry shape, where the whole
 * policy depends on `convertFlatSharedInfo`, is in `vendor-shapes.e2e.spec.ts`.
 */
const M = '@angular/material';
const TAG = '22.0.6';
const REQ = '~22.0.6';
const build = (remote: 1 | 2 | 3, tag = TAG) => `mfe${remote}|${M}@${tag}`;

const narrow = (name: string, scope: string) =>
  remote(name, scope, [dep(M, TAG, { req: REQ, entrypoints: ['/table'] })]);

const wide = (name: string, scope: string) =>
  remote(name, scope, [dep(M, TAG, { req: REQ, entrypoints: ['/table', '/sort'] })]);

test.describe('entrypoint coverage: electing the basis', () => {
  test('serves every entrypoint from the widest remote', async ({ nf }) => {
    await nf.init([
      narrow('team/mfe1', SCOPE.mfe1),
      narrow('team/mfe2', SCOPE.mfe2),
      wide('team/mfe3', SCOPE.mfe3),
    ]);

    const map = await nf.map();
    expect(map.imports[M]).toBe(`${SCOPE.mfe3}${M}.js`);
    expect(map.imports[`${M}/table`]).toBe(`${SCOPE.mfe3}${M}/table.js`);
    expect(map.imports[`${M}/sort`]).toBe(`${SCOPE.mfe3}${M}/sort.js`);
    expect(map.scopes).toBeUndefined();

    // One build on the page, and the narrow remotes resolve their entrypoints to it — the package is
    // not torn. Three files for three entrypoints is the whole cost.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe1']!.seen).toEqual({
      [M]: build(3),
      [`${M}/table`]: build(3),
    });
    expect(await nf.buildsOf(M)).toEqual([build(3)]);
    expect(nf.downloads()).toEqual([
      `${SCOPE.mfe3}${M}.js`,
      `${SCOPE.mfe3}${M}/table.js`,
      `${SCOPE.mfe3}${M}/sort.js`,
    ]);
  });

  test('elects the same basis whatever order the remotes arrive in', async ({ nf }) => {
    await nf.init([
      wide('team/mfe3', SCOPE.mfe3),
      narrow('team/mfe1', SCOPE.mfe1),
      narrow('team/mfe2', SCOPE.mfe2),
    ]);

    const map = await nf.map();
    expect(map.imports[`${M}/table`]).toBe(`${SCOPE.mfe3}${M}/table.js`);
    expect(map.imports[`${M}/sort`]).toBe(`${SCOPE.mfe3}${M}/sort.js`);

    await nf.loadAll();
    expect(await nf.buildsOf(M)).toEqual([build(3)]);
  });

  test('fills the remainder from a sibling when no remote covers everything', async ({ nf }) => {
    // Coverage is not a total order: mfe1 has /sort, mfe3 has /paginator, neither has both. The basis
    // serves what it can and the uncovered entrypoint comes from the sibling that declares it.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep(M, TAG, { req: REQ, entrypoints: ['/table', '/sort'] }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep(M, TAG, { req: REQ, entrypoints: ['/table', '/paginator'] }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports[`${M}/table`]).toBe(`${SCOPE.mfe1}${M}/table.js`);
    expect(map.imports[`${M}/sort`]).toBe(`${SCOPE.mfe1}${M}/sort.js`);
    expect(map.imports[`${M}/paginator`]).toBe(`${SCOPE.mfe3}${M}/paginator.js`);

    // The price of self-fill, which only a real page shows: mfe3 takes the basis for what it covers
    // and its own build for `/paginator`, so both builds are evaluated. Every entrypoint still
    // resolves, and because both copies carry one tag this is a merge rather than a tear — so neither
    // coverage setting changes it.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe3']!.seen).toEqual({
      [M]: build(1),
      [`${M}/table`]: build(1),
      [`${M}/paginator`]: build(3),
    });
    expect(await nf.buildsOf(M)).toEqual([build(1), build(3)]);
    // Drawing one package from two builds does not island mfe3, for two independent reasons: both builds
    // ship the same tag, so the map serves mfe3 every specifier at exactly the version its own build
    // shipped — the witness of the provenance promise — and a one-member pool has nothing to coordinate
    // in any case. What the promise rules out is a *tag* mismatch across builds, not two origins of one.
    expect(await nf.islands()).toEqual([]);
  });
});

test.describe('entrypoint coverage: a remote joining an already-resolved version', () => {
  // A remote joining a version that is already cached and resolved: the tag list does not change, so
  // `dirty` used to stay false and the cached actions were never revisited.
  const joined = (): [ReturnType<typeof narrow>, ReturnType<typeof wide>] => [
    narrow('team/mfe1', SCOPE.mfe1),
    wide('team/mfe3', SCOPE.mfe3),
  ];

  test('self-fills the joining remote by default', async ({ nf }) => {
    const [first, late] = joined();
    await nf.init([first]);
    expect((await nf.map()).imports[`${M}/sort`]).toBeUndefined();

    await nf.init([first, late]);
    expect(nf.fetches()).toEqual([late.url]);

    const map = await nf.map();
    expect(map.imports[`${M}/table`]).toBe(`${SCOPE.mfe1}${M}/table.js`);
    expect(map.imports[`${M}/sort`]).toBe(`${SCOPE.mfe3}${M}/sort.js`);
    expect(storedActions(await nf.store(), M)).toEqual([`${TAG}:share`]);
  });

  // The joiner builds the tag that is already shared, so the two copies merge and the union of their
  // entrypoints is published. Both coverage settings only govern tears *between* versions, so neither
  // splits the joiner out — nothing here is torn to begin with.
  for (const [name, profile, strict] of [
    ['scopeUncoveredEntrypoints', { scopeUncoveredEntrypoints: true }, undefined],
    ['strictEntryPointCoverage', undefined, { strictEntryPointCoverage: true }],
  ] as const) {
    test(`merges the joining remote into the cached version under ${name}`, async ({ nf }) => {
      const [first, late] = joined();
      const options = { ...(profile ? { profile } : {}), ...(strict ? { strict } : {}) };
      await nf.init([first], options);
      await nf.init([first, late], options);

      // One record on the tag: the joiner deduped into the shared copy rather than taking its own.
      expect(storedActions(await nf.store(), M)).toEqual([`${TAG}:share`]);

      const map = await nf.map();
      expect(map.imports[`${M}/table`]).toBe(`${SCOPE.mfe1}${M}/table.js`);
      // `/sort` is the entrypoint only the joiner bundles, published from its build at the same tag.
      expect(map.imports[`${M}/sort`]).toBe(`${SCOPE.mfe3}${M}/sort.js`);
      expect((await nf.load('team/mfe3')).seen).toEqual({
        [M]: build(1),
        [`${M}/table`]: build(1),
        [`${M}/sort`]: build(3),
      });
    });
  }

  test('re-resolves compatibility when a strict remote joins a skipped version', async ({ nf }) => {
    // 22.0.5 is skipped on the first init because mfe2 accepts whatever is shared. mfe3 then joins
    // that same skipped tag with a strict `~22.0.5`, which 22.1.0 does not satisfy — so the version has
    // to be re-resolved even though no new tag appeared. mfe1's copy is already cached, so giving it
    // up is free and 22.0.5 becomes the shared build.
    const first = [
      remote('team/mfe1', SCOPE.mfe1, [
        dep(M, '22.1.0', { req: '~22.1.0', entrypoints: ['/table'] }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep(M, '22.0.5', { req: '^22.0.0', strict: false, entrypoints: ['/table'] }),
      ]),
    ];
    await nf.init(first);
    expect(storedActions(await nf.store(), M)).toEqual(['22.1.0:share', '22.0.5:skip']);

    const late = remote('team/mfe3', SCOPE.mfe3, [
      dep(M, '22.0.5', { req: '~22.0.5', entrypoints: ['/table'] }),
    ]);
    await nf.init([...first, late]);

    expect(storedActions(await nf.store(), M)).toEqual(['22.1.0:scope', '22.0.5:share']);
    expect((await nf.map()).imports[`${M}/table`]).toBe(`${SCOPE.mfe2}${M}/table.js`);
    expect((await nf.load('team/mfe3')).seen[`${M}/table`]).toBe(build(2, '22.0.5'));
    // mfe1 keeps the build it already downloaded rather than sharing one it cannot accept.
    expect((await nf.load('team/mfe1')).seen[`${M}/table`]).toBe(build(1, '22.1.0'));
  });

  test('resolves the cold portfolio to an equal-cost winner of its own', async ({ nf }) => {
    // Same three remotes as the test above, assembled in one go. It used to reach the same verdict, and
    // that was an artefact of the objective charging a rejected version for every copy: electing 22.1.0
    // looked like two downloads against 22.0.5's one. Priced per copy — only mfe3 pins — both cost one,
    // and a genuine tie breaks toward the newest tag.
    //
    // Cost is unchanged either way: two builds on the page. Here mfe1 serves its own 22.1.0 with mfe2
    // deduping onto it (`^22.0.0` accepts it) and mfe3 alone self-serving; incrementally, mfe1's copy is
    // already downloaded, so giving it up is free and 22.0.5 wins instead. That is the cost model working
    // as designed — a cached copy costs nothing — not a divergence to fix.
    //
    // What the regression above guards is unaffected and still asserted there: joining an existing tag
    // dirties the external, so the incremental portfolio re-resolves rather than keeping a stale verdict.
    const portfolio = [
      remote('team/mfe1', SCOPE.mfe1, [
        dep(M, '22.1.0', { req: '~22.1.0', entrypoints: ['/table'] }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep(M, '22.0.5', { req: '^22.0.0', strict: false, entrypoints: ['/table'] }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep(M, '22.0.5', { req: '~22.0.5', entrypoints: ['/table'] }),
      ]),
    ];

    await nf.init(portfolio);

    // 22.0.5 splits: mfe2 dedups onto the winner, mfe3's pin keeps its own build.
    expect(storedActions(await nf.store(), M)).toEqual([
      '22.1.0:share',
      '22.0.5:skip',
      '22.0.5:scope',
    ]);
    expect((await nf.map()).imports[`${M}/table`]).toBe(`${SCOPE.mfe1}${M}/table.js`);
    expect((await nf.load('team/mfe2')).seen[`${M}/table`]).toBe(build(1, '22.1.0'));
    expect((await nf.load('team/mfe3')).seen[`${M}/table`]).toBe(build(3, '22.0.5'));
  });
});
