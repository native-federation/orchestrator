import { test, expect, sharedTags } from '../harness/federation';
import { dep, remote, SCOPE } from '../harness/portfolio';

/**
 * **Asymmetric pool families**: the remotes declare *different members* of one family. Now two questions
 * are live at once — which version wins, and which build serves a member — and they interact: a remote
 * that is the sole provider of one member and a consumer of another is the shape every #63 reproduction
 * has, because it is the remote that can end up holding two builds.
 *
 * Four asymmetries appear below, in rising difficulty: containment (one remote's set is a subset of
 * another's), ragged coverage (each remote solely provides something), disjointness (two remotes of one
 * pool share no member at all), and the entrypoint case (the sets differ *inside* one package).
 *
 * Same-member-set families are `symmetric.e2e.spec.ts`; the feature flag is `flag.e2e.spec.ts`.
 */
test.describe('asymmetric: containment and ragged coverage', () => {
  test('shares one copy per member when the ranges are compatible', async ({ nf }) => {
    // The asymmetric baseline: mfe2 ships a strict subset at the same tag, so it dedups everything and
    // contributes nothing of its own.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.1.0', { req: '^22.0.0' })]),
    ]);

    expect((await nf.map()).scopes).toBeUndefined();
    await nf.loadAll();
    expect(await nf.buildsOf('@angular/core')).toEqual(['mfe1|@angular/core@22.1.0']);
    expect(nf.downloads()).toEqual([
      'http://mfe1/@angular/core.js',
      'http://mfe1/@angular/router.js',
    ]);
  });

  test('never islands the subset consumer of an asymmetric family', async ({ nf }) => {
    // Containment is directional: mfe2 ships {core, common} and can be served entirely by mfe1's
    // {core, common, material} build. Every build agrees at minor granularity, so material — provided by
    // mfe1 alone — stays globally shared and mfe2 keeps deduping. The regression this locks is gratuitous
    // scoping, which a single-build-per-remote rule would have caused for mfe1.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '17.0.1', { req: '^17.0.0' }),
        dep('@angular/common', '17.0.1', { req: '^17.0.0' }),
        dep('@angular/material', '17.0.1', { req: '^17.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '17.0.0', { req: '^17.0.0' }),
        dep('@angular/common', '17.0.0', { req: '^17.0.0' }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/common']).toBe('http://mfe1/@angular/common.js');
    expect(map.imports['@angular/material']).toBe('http://mfe1/@angular/material.js');
    expect(map.scopes).toBeUndefined();
    expect(await nf.islands()).toEqual([]);
  });

  test('self-serves the sole provider whose own tag lost the election', async ({ nf }) => {
    // **Rewritten for the provenance promise** (#63); it read `tolerates patch drift when each remote
    // solely provides a member`.
    //
    // Both remotes declare ~21.2.0 and sit one patch apart, and each solely provides one member. core is a
    // tie the newest tag wins. What the old promise allowed: mfe2 drew core from mfe1 (21.2.3) and ran it
    // beside its own forms (21.2.2) — two builds on one minor line, so they were held to agree, nothing
    // was scoped and the family cost 3 downloads. What the new promise requires: no build ever shipped
    // core@21.2.3 beside forms@21.2.2, so mfe2 takes its whole family from its own build.
    // **Delta: +1 download** (3 → 4), and mfe2's forms leaves the shared set with it.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '21.2.3', { req: '~21.2.0' }),
        dep('@angular/router', '21.2.3', { req: '~21.2.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '21.2.2', { req: '~21.2.0' }),
        dep('@angular/forms', '21.2.2', { req: '~21.2.0' }),
      ]),
    ]);

    expect(await nf.islands()).toEqual(['team/mfe2 self-serves, no build covers @angular/forms']);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
    // forms had mfe2 as its only provider, and mfe2 now runs its own copy: nothing is left to publish
    // globally, so the member leaves the shared set rather than being served off a build that lost.
    expect(map.imports['@angular/forms']).toBeUndefined();
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
      '@angular/forms': 'http://mfe2/@angular/forms.js',
    });

    // The report names forms, not core: the gap is what the closest build fell short on, and mfe1 does
    // not carry forms at all. Two members, not the pool's three — mfe2 ships no router.
    expect(await nf.warns()).toEqual([
      expect.stringContaining(
        "'team/mfe2' serves its own family: no shared build offers every entrypoint it imports at a version it accepts — '@angular/forms' is the gap, closest is 'team/mfe1'. All 2 members it imports are scoped for it."
      ),
    ]);

    const loaded = await nf.loadAll();
    expect(loaded['team/mfe2']!.seen).toEqual({
      '@angular/core': 'mfe2|@angular/core@21.2.2',
      '@angular/forms': 'mfe2|@angular/forms@21.2.2',
    });
    // mfe1 is untouched — it wins both its members and pays nothing for mfe2's coherence.
    expect(loaded['team/mfe1']!.seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@21.2.3',
      '@angular/router': 'mfe1|@angular/router@21.2.3',
    });
    expect(nf.downloads()).toHaveLength(4);
  });

  test('self-serves every sole provider but the one whose build won', async ({ nf }) => {
    // **Rewritten for the provenance promise** (#63); it read `islands nobody on ragged coverage with
    // patch drift`.
    //
    // Every remote is the sole provider of one member and the family carries three patch tags. The old
    // promise read minor-line agreement and islanded nobody, at one download per member — mfe1 running
    // 22.0.7 core beside its own 22.0.5 only-1, a pair nothing compiled. Under the new promise only mfe3
    // keeps deduping, because the shared set already serves both members it imports at exactly its own
    // tags: its own build is the witness. mfe1 and mfe2 each self-serve.
    // **Delta: +2 downloads** (4 → 6), one per remote that lost the core election.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
        dep('@angular/only-1', '22.0.5', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.0.6', { req: '^22.0.0' }),
        dep('@angular/only-2', '22.0.6', { req: '^22.0.0' }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep('@angular/core', '22.0.7', { req: '^22.0.0' }),
        dep('@angular/only-3', '22.0.7', { req: '^22.0.0' }),
      ]),
    ]);

    expect(await nf.islands()).toEqual([
      'team/mfe1 self-serves, no build covers @angular/only-1',
      'team/mfe2 self-serves, no build covers @angular/only-2',
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe3/@angular/core.js');
    expect(map.imports['@angular/only-3']).toBe('http://mfe3/@angular/only-3.js');
    // Their sole-provided members go with them; only the winning build's pair stays global.
    expect(map.imports['@angular/only-1']).toBeUndefined();
    expect(map.imports['@angular/only-2']).toBeUndefined();
    expect(map.scopes).toEqual({
      [SCOPE.mfe1]: {
        '@angular/core': 'http://mfe1/@angular/core.js',
        '@angular/only-1': 'http://mfe1/@angular/only-1.js',
      },
      [SCOPE.mfe2]: {
        '@angular/core': 'http://mfe2/@angular/core.js',
        '@angular/only-2': 'http://mfe2/@angular/only-2.js',
      },
    });

    // Every remote now runs one build, its own or the winner's, and nothing straddles two.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe1']!.seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.0.5',
      '@angular/only-1': 'mfe1|@angular/only-1@22.0.5',
    });
    expect(loaded['team/mfe3']!.seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@22.0.7',
      '@angular/only-3': 'mfe3|@angular/only-3@22.0.7',
    });
    expect(nf.downloads()).toHaveLength(6);
  });

  test('lets disjoint builds of one pool agree vacuously', async ({ nf }) => {
    // The extreme of asymmetry: two remotes in the same npm scope that share no member at all. mfe1 ships
    // {core, router}, mfe2 ships {material, cdk}, majors apart. They are one pool by membership, but no
    // build serves a member the other ships, so the pairwise comparison has nothing to compare and ragged
    // coverage stays cheap.
    //
    // The comparison is pairwise *between serving builds*, which is what makes this vacuous. It stays
    // sound only while no single remote consumes members from both sides — a remote that did would be the
    // witness relating the two tags, and it is not part of the comparison.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/material', '17.0.0', { req: '^17.0.0' }),
        dep('@angular/cdk', '17.0.0', { req: '^17.0.0' }),
      ]),
    ]);

    expect((await nf.map()).scopes).toBeUndefined();
    expect(await nf.islands()).toEqual([]);
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(4);
  });
});

test.describe('asymmetric: the split family', () => {
  test('islands across a minor gap', async ({ nf }) => {
    // The split-family trigger, and the smallest portfolio that has it. mfe2's strict `~22.0.5` pin drags
    // the shared core DOWN to its own build, while router — which mfe2 does not ship — resolves freely to
    // mfe1's 22.1.0. mfe1 would then run router@22.1.0 against a deduped core@22.0.5, so it serves its
    // whole family itself.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe2/@angular/core.js');
    expect(map.scopes?.[SCOPE.mfe1]).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
      '@angular/router': 'http://mfe1/@angular/router.js',
    });
    // router had no second provider, so it leaves the shared set with mfe1's copy.
    expect(map.imports['@angular/router']).toBeUndefined();
    expect(await nf.islands()).toEqual(['team/mfe1 self-serves, no build covers @angular/router']);

    // The fix, at runtime: neither remote runs a mixed family.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe1']!.seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.1.0',
      '@angular/router': 'mfe1|@angular/router@22.1.0',
    });
    expect(loaded['team/mfe2']!.seen).toEqual({ '@angular/core': 'mfe2|@angular/core@22.0.5' });
  });

  test('names the gap and the closest build in a single warning', async ({ nf }) => {
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]),
    ]);

    // The island warning already explains why router lost its last provider, so `warnIfScopedOnly` must
    // not restate that effect.
    expect(await nf.warns()).toEqual([
      expect.stringContaining(
        "'team/mfe1' serves its own family: no shared build offers every entrypoint it imports at a version it accepts — '@angular/router' is the gap, closest is 'team/mfe2'. All 2 members it imports are scoped for it."
      ),
    ]);
  });

  test('islands a remote whose own build disagrees even when its range accepts the shared tag', async ({
    nf,
  }) => {
    // `strictVersion: false` means "accept whatever is shared", so the resolver grants this remote a dedup
    // of core@22.1.0 despite its own 21.2.18. It also solely provides animations@21.2.18 — so taking that
    // dedup would run Angular 21 animations against an Angular 22 core. The declared range cannot
    // discriminate here; the minor line can, and does.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '21.2.18', { req: '^21.0.0', strict: false }),
        dep('@angular/animations', '21.2.18', { req: '^21.0.0', strict: false }),
      ]),
    ]);

    const map = await nf.map();
    expect(await nf.islands()).toEqual([
      'team/mfe2 self-serves, no build covers @angular/animations',
    ]);
    expect(map.imports['@angular/animations']).toBeUndefined();
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
      '@angular/animations': 'http://mfe2/@angular/animations.js',
    });
    expect((await nf.loadAll())['team/mfe2']!.seen).toEqual({
      '@angular/core': 'mfe2|@angular/core@21.2.18',
      '@angular/animations': 'mfe2|@angular/animations@21.2.18',
    });
  });
});

/**
 * The failure mode neither split-family reproduction shows: the *shared set itself* is incoherent, not
 * just one remote's view of it.
 *
 * mfe3 below is correctly islanded on the members it conflicts on, but it is also the sole provider of
 * others. Islanding governs whose copies get deduped; it says nothing about who serves a member nobody
 * else ships — so before the fix `@angular/animations@21.2.18` stayed globally shared beside
 * `@angular/core@22.0.8`, and any remote consuming both loaded Angular 21 animations against an Angular 22
 * core. The rule that repairs it: an islanded remote contributes NO build at all, not even for members it
 * solely provides.
 */
test.describe('asymmetric: the shared set stays coherent', () => {
  const portfolio = () => [
    remote('team/mfe1', SCOPE.mfe1, [
      dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
      dep('@angular/common', '22.0.8', { req: '~22.0.3' }),
    ]),
    remote('team/mfe2', SCOPE.mfe2, [
      dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
      dep('@angular/common', '22.0.8', { req: '~22.0.3' }),
    ]),
    remote('team/mfe3', SCOPE.mfe3, [
      dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
      dep('@angular/common', '21.2.18', { req: '~21.2.0' }),
      dep('@angular/animations', '21.2.18', { req: '~21.2.0' }),
      dep('@angular/compiler', '21.2.18', { req: '~21.2.0' }),
    ]),
  ];

  test('drops the sole-provided members of an islanded remote from the shared set', async ({
    nf,
  }) => {
    await nf.init(portfolio());

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/common']).toBe('http://mfe1/@angular/common.js');

    // The members only the islanded remote ships are NOT published globally at 21.2.18 next to a shared
    // core@22.0.8 — they go with the island.
    expect(map.imports['@angular/animations']).toBeUndefined();
    expect(map.imports['@angular/compiler']).toBeUndefined();
    expect(map.scopes?.[SCOPE.mfe3]).toEqual({
      '@angular/core': 'http://mfe3/@angular/core.js',
      '@angular/common': 'http://mfe3/@angular/common.js',
      '@angular/animations': 'http://mfe3/@angular/animations.js',
      '@angular/compiler': 'http://mfe3/@angular/compiler.js',
    });

    // And nothing outside the island can reach the 21 build at all — the strongest form of the claim.
    expect(await nf.resolve('@angular/animations', SCOPE.mfe1)).toContain('UNRESOLVED');
    expect(await nf.resolve('@angular/animations', SCOPE.mfe3)).toBe(
      'mfe3|@angular/animations@21.2.18'
    );
  });

  test('leaves exactly one major in the shared set, no package split across two tags', async ({
    nf,
  }) => {
    await nf.init(portfolio());

    // The coherence measure, read off the committed store: every shared tag on one major, and no member
    // shared at two tags at once.
    const shared = sharedTags(await nf.store());
    expect(shared).toEqual({
      '@angular/core': ['22.0.8'],
      '@angular/common': ['22.0.8'],
      '@angular/animations': [],
      '@angular/compiler': [],
    });

    const majors = new Set(
      Object.values(shared)
        .flat()
        .map(tag => tag.split('.')[0])
    );
    expect(majors).toEqual(new Set(['22']));
  });

  test('cascades: an island that removes a member’s last provider can island its consumers', async ({
    nf,
  }) => {
    // Islanding is monotone, so the gate iterates to a fixed point.
    //
    // mfe3 is islanded on core by strict incompatibility (gate 1), and it was the elected provider of
    // forms@22.0.8. With its copies gone, forms has no serving build, so mfe2 must self-serve forms@22.1.0
    // while deduping core@22.0.8 from mfe1 — builds that disagree across a minor line, which islands mfe2
    // in turn (gate 2).
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/forms', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        dep('@angular/forms', '22.0.8', { req: '~22.0.3' }),
      ]),
    ]);

    expect(await nf.islands()).toEqual([
      'team/mfe2 self-serves, no build covers @angular/forms',
      'team/mfe3 on @angular/core@21.2.18',
    ]);

    // core keeps its provider; forms ends up shared by nobody, and both islanded remotes self-serve.
    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/forms']).toBeUndefined();
    expect(map.scopes).toEqual({
      [SCOPE.mfe2]: {
        '@angular/core': 'http://mfe2/@angular/core.js',
        '@angular/forms': 'http://mfe2/@angular/forms.js',
      },
      [SCOPE.mfe3]: {
        '@angular/core': 'http://mfe3/@angular/core.js',
        '@angular/forms': 'http://mfe3/@angular/forms.js',
      },
    });

    // Three builds of core live on the page, and every remote's forms matches its own core.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe2']!.seen).toEqual({
      '@angular/core': 'mfe2|@angular/core@22.1.0',
      '@angular/forms': 'mfe2|@angular/forms@22.1.0',
    });
    expect(loaded['team/mfe3']!.seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@21.2.18',
      '@angular/forms': 'mfe3|@angular/forms@22.0.8',
    });
  });

  test('keeps an entrypoint nobody else provides out of the shared set too', async ({ nf }) => {
    // Asymmetry at both granularities at once: the islanded remote is also the only one that bundles
    // `@angular/material/sort`. The serving basis for the shared material@22.0.8 covers the root and
    // `/table`; `/sort` has no provider left once the island contributes nothing, so — like a
    // sole-provided *member* — it must simply not exist globally rather than be published off a 21 build.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
        dep('@angular/material', '22.0.8', { req: '~22.0.3', entrypoints: ['/table'] }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
        dep('@angular/material', '22.0.8', { req: '~22.0.3', entrypoints: ['/table'] }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        dep('@angular/material', '21.2.18', { req: '~21.2.0', entrypoints: ['/table', '/sort'] }),
      ]),
    ]);

    expect(await nf.islands()).toEqual(['team/mfe3 on @angular/core@21.2.18']);

    const map = await nf.map();
    expect(map.imports['@angular/material']).toBe('http://mfe1/@angular/material.js');
    expect(map.imports['@angular/material/table']).toBe('http://mfe1/@angular/material/table.js');
    expect(map.imports['@angular/material/sort']).toBeUndefined();

    // The islanded remote gets every entrypoint it declares from its own build, `/sort` included.
    expect(map.scopes?.[SCOPE.mfe3]).toEqual({
      '@angular/core': 'http://mfe3/@angular/core.js',
      '@angular/material': 'http://mfe3/@angular/material.js',
      '@angular/material/table': 'http://mfe3/@angular/material/table.js',
      '@angular/material/sort': 'http://mfe3/@angular/material/sort.js',
    });
    expect((await nf.loadAll())['team/mfe3']!.seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@21.2.18',
      '@angular/material': 'mfe3|@angular/material@21.2.18',
      '@angular/material/table': 'mfe3|@angular/material@21.2.18',
      '@angular/material/sort': 'mfe3|@angular/material@21.2.18',
    });
    expect(await nf.resolve('@angular/material/sort', SCOPE.mfe1)).toContain('UNRESOLVED');
  });
});

/**
 * CHARACTERISATION of what the islanding-cascade follow-up leaves open: the objective is exact per
 * external, but it is still evaluated *per external*. Two members of one pool whose remote-count
 * majorities sit on different version lines still elect opposite winners, and pooling still amplifies the
 * split. A failure here is probably good news — read the follow-up before "repairing" it.
 */
test.describe('asymmetric: residual — per-member elections can still split a pool', () => {
  test('splits a family when each member has its majority on a different line', async ({ nf }) => {
    // core's modern side is larger, router's previous-major side is larger.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
        dep('@angular/router', '22.0.8', { req: '~22.0.3' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/mfe3', SCOPE.mfe3, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/mfe4', SCOPE.mfe4, [
        dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        dep('@angular/router', '21.2.18', { req: '~21.2.0' }),
      ]),
      remote('team/mfe5', SCOPE.mfe5, [dep('@angular/router', '21.2.18', { req: '~21.2.0' })]),
    ]);

    // Each winner is the cheaper one for its own member, and together they cost mfe1 its family. core is
    // still shared at 22.0.8 — but from mfe2, because islanding mfe1 removed its copy and with it the
    // serving basis.
    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe2/@angular/core.js');
    // Likewise router: shared at 21.2.18, served by mfe5 once mfe4's copy is islanded away.
    expect(map.imports['@angular/router']).toBe('http://mfe5/@angular/router.js');
    expect(await nf.islands()).toEqual([
      'team/mfe1 on @angular/router@22.0.8',
      'team/mfe4 on @angular/core@21.2.18',
    ]);

    // The residual is a cost problem, not a coherence one: every remote still runs one build per family.
    // mfe2 is the remote to watch — it dedups core@22.0.8 and ships no router at all.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe1']!.seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.0.8',
      '@angular/router': 'mfe1|@angular/router@22.0.8',
    });
    expect(loaded['team/mfe5']!.seen).toEqual({
      '@angular/router': 'mfe5|@angular/router@21.2.18',
    });
  });
});
