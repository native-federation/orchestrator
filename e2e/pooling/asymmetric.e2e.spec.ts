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

    expect(await nf.islands()).toEqual(['team/mfe2 uncovered']);

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

    expect(await nf.islands()).toEqual(['team/mfe1 uncovered', 'team/mfe2 uncovered']);

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
    // The split-family trigger, and the smallest portfolio that has it. Per-member election let mfe2's
    // strict `~22.0.5` pin drag the shared core down while router stayed on mfe1's 22.1.0, so mfe1 had to
    // island. Electing the family: neither build serves the other remote and nobody agrees with either, so
    // the newer build wins round 1 and the pinner runs its own core.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({ '@angular/core': 'http://mfe2/@angular/core.js' });
    expect(await nf.islands()).toEqual(['team/mfe2 incompatible']);

    // The fix, at runtime: neither remote runs a mixed family.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe1']!.seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.1.0',
      '@angular/router': 'mfe1|@angular/router@22.1.0',
    });
    expect(loaded['team/mfe2']!.seen).toEqual({ '@angular/core': 'mfe2|@angular/core@22.0.5' });
  });

  test('islands a remote whose own build disagrees even when its range accepts the shared tag', async ({
    nf,
  }) => {
    // `strictVersion: false` means "accept whatever is shared" to the per-external resolver, but a pool
    // reads the range itself: ^21.0.0 rejects the elected core@22.1.0, so mfe2 runs its own family rather
    // than Angular 21 animations against an Angular 22 core.
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
    expect(await nf.islands()).toEqual(['team/mfe2 incompatible']);
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

  test('no longer cascades: an island cannot take a member’s last provider from the elected build', async ({
    nf,
  }) => {
    // Formerly a cascade: islanding mfe3 took forms' last provider and islanded mfe2 in turn. Electing the
    // family, no build serves another remote and nobody agrees with any, so the newest build (mfe2's
    // 22.1.0) wins round 1 and both others run their own. Same five downloads, no cascade.
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

    expect(await nf.islands()).toEqual(['team/mfe1 incompatible', 'team/mfe3 incompatible']);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe2/@angular/core.js');
    expect(map.imports['@angular/forms']).toBe('http://mfe2/@angular/forms.js');
    expect(map.scopes).toEqual({
      [SCOPE.mfe1]: { '@angular/core': 'http://mfe1/@angular/core.js' },
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

    expect(await nf.islands()).toEqual(['team/mfe3 incompatible']);

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
