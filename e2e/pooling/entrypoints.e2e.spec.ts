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
    // resolves — that is what `scopeUncoveredEntrypoints` trades away below.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe3']!.seen).toEqual({
      [M]: build(1),
      [`${M}/table`]: build(1),
      [`${M}/paginator`]: build(3),
    });
    expect(await nf.buildsOf(M)).toEqual([build(1), build(3)]);
    // Drawing one package from two builds does not island mfe3: the disagreement gate compares
    // *members of a family*, and a one-member pool has no member to disagree about.
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

  test('scopes the joining remote when the cached basis cannot cover it', async ({ nf }) => {
    const [first, late] = joined();
    const profile = { scopeUncoveredEntrypoints: true };
    await nf.init([first], { profile });
    await nf.init([first, late], { profile });

    // Two records on one tag: the cached basis keeps the shared copy, the newcomer takes a scoped one.
    expect(storedActions(await nf.store(), M)).toEqual([`${TAG}:share`, `${TAG}:scope`]);

    const map = await nf.map();
    expect(map.imports[`${M}/table`]).toBe(`${SCOPE.mfe1}${M}/table.js`);
    // The whole package from mfe3's own build, so it is not torn across two.
    expect(map.scopes?.[SCOPE.mfe3]).toEqual({
      [M]: `${SCOPE.mfe3}${M}.js`,
      [`${M}/table`]: `${SCOPE.mfe3}${M}/table.js`,
      [`${M}/sort`]: `${SCOPE.mfe3}${M}/sort.js`,
    });
    expect((await nf.load('team/mfe3')).seen).toEqual({
      [M]: build(3),
      [`${M}/table`]: build(3),
      [`${M}/sort`]: build(3),
    });
  });

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

  test('reaches the same verdict incrementally as it does cold', async ({ nf }) => {
    // The regression itself: joining an existing tag must dirty the external. If it does not, the
    // incremental portfolio keeps the stale verdict and diverges from the cold one.
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

    expect(storedActions(await nf.store(), M)).toEqual(['22.1.0:scope', '22.0.5:share']);
    expect((await nf.map()).imports[`${M}/table`]).toBe(`${SCOPE.mfe2}${M}/table.js`);
  });
});
