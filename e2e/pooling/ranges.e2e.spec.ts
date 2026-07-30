import { test, expect } from '../harness/federation';
import { dep, remote, SCOPE } from '../harness/portfolio';

/**
 * The version fields of a shared external — `version`, `requiredVersion`, `strictVersion` — and which
 * combinations let a remote dedup a family versus serve it from its own build.
 *
 * The agreement gate asks one question of a remote's draw: do the builds it would draw on place a
 * member they both ship on the same **minor line**? Exact-tag agreement was measured and rejected — on
 * ragged portfolios it islanded 66–68% of remotes and cost 3–6× the downloads. Minor-line agreement
 * islands nothing on patch drift and still catches every real split: the split-family reproductions
 * differ at minor, the cross-major capture at major. What it deliberately gives up is unifying `21.2.2`
 * with `21.2.3`: benign patch drift inside a family is tolerated, not repaired.
 */
test.describe('ranges: what agreement tolerates', () => {
  test('one tag, compatible ranges: one copy for the whole portfolio', async ({ nf }) => {
    // The baseline every other case is a deviation from.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [dep('@angular/core', '22.1.0', { req: '^22.0.0' })]),
    ]);

    expect((await nf.map()).scopes).toBeUndefined();
    await nf.loadAll();
    expect(await nf.buildsOf('@angular/core')).toEqual(['mfe-a|@angular/core@22.1.0']);
    expect(nf.downloads()).toEqual([
      'http://mfe-a/@angular/core.js',
      'http://mfe-a/@angular/router.js',
    ]);
  });

  test('tolerates patch drift inside one minor line', async ({ nf }) => {
    // Both remotes declare ~21.2.0 and sit one patch apart. core is a tie the newest tag wins, so
    // mfe-b draws core from mfe-a (21.2.3) and forms from itself (21.2.2): two builds on the same
    // minor line, so they agree and nobody is islanded.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '21.2.3', { req: '~21.2.0' }),
        dep('@angular/router', '21.2.3', { req: '~21.2.0' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [
        dep('@angular/core', '21.2.2', { req: '~21.2.0' }),
        dep('@angular/forms', '21.2.2', { req: '~21.2.0' }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe-a/@angular/router.js');
    expect(map.imports['@angular/forms']).toBe('http://mfe-b/@angular/forms.js');

    // Nothing scoped at all, so the map carries no `scopes` key, and the family costs 3 downloads.
    expect(map.scopes).toBeUndefined();
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(3);

    // What "tolerated, not repaired" means concretely: mfe-b's code runs 21.2.3 core beside its own
    // 21.2.2 forms.
    expect((await nf.loadAll())['team/mfe-b']!.seen).toEqual({
      '@angular/core': 'mfe-a|@angular/core@21.2.3',
      '@angular/forms': 'mfe-b|@angular/forms@21.2.2',
    });

    // Multi-build draws are the normal case, so they stay `debug`; `warn` is reserved for islands.
    expect(await nf.debugs()).toContainEqual(
      expect.stringContaining("'team/mfe-b' draws from 2 agreeing builds")
    );
    expect(await nf.warns()).toEqual([]);
  });

  test('islands nobody on ragged coverage with patch drift', async ({ nf }) => {
    // The regime exact-tag agreement broke: every remote is the sole provider of one member, and the
    // family carries three patch tags. Exact-tag agreement islanded two thirds of remotes here;
    // minor-line agreement islands nobody and the family costs one download per member.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
        dep('@angular/only-a', '22.0.5', { req: '^22.0.0' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [
        dep('@angular/core', '22.0.6', { req: '^22.0.0' }),
        dep('@angular/only-b', '22.0.6', { req: '^22.0.0' }),
      ]),
      remote('team/mfe-c', SCOPE.c, [
        dep('@angular/core', '22.0.7', { req: '^22.0.0' }),
        dep('@angular/only-c', '22.0.7', { req: '^22.0.0' }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.scopes).toBeUndefined();
    expect(await nf.islands()).toEqual([]);
    expect(map.imports['@angular/core']).toBe('http://mfe-c/@angular/core.js');
    expect(map.imports['@angular/only-a']).toBe('http://mfe-a/@angular/only-a.js');
    expect(map.imports['@angular/only-b']).toBe('http://mfe-b/@angular/only-b.js');
    expect(map.imports['@angular/only-c']).toBe('http://mfe-c/@angular/only-c.js');

    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(4);
  });

  test('never islands the subset consumer of an asymmetric family', async ({ nf }) => {
    // Containment is directional: mfe-b ships {core, common} and can be served entirely by mfe-a's
    // {core, common, material} build. Every build agrees at minor granularity, so material — provided
    // by mfe-a alone — stays globally shared and mfe-b keeps deduping. The regression this locks is
    // gratuitous scoping, which a single-build-per-remote rule would have caused for mfe-a.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '17.0.1', { req: '^17.0.0' }),
        dep('@angular/common', '17.0.1', { req: '^17.0.0' }),
        dep('@angular/material', '17.0.1', { req: '^17.0.0' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [
        dep('@angular/core', '17.0.0', { req: '^17.0.0' }),
        dep('@angular/common', '17.0.0', { req: '^17.0.0' }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(map.imports['@angular/common']).toBe('http://mfe-a/@angular/common.js');
    expect(map.imports['@angular/material']).toBe('http://mfe-a/@angular/material.js');
    expect(map.scopes).toBeUndefined();
    expect(await nf.islands()).toEqual([]);
  });

  test('lets disjoint builds of one pool agree vacuously', async ({ nf }) => {
    // Two remotes in the same npm scope that share no member: mfe-a ships {core, router}, mfe-b ships
    // {material, cdk}, majors apart. They are one pool by membership, but no build serves a member the
    // other ships, so there is nothing to disagree about and ragged coverage stays cheap.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [
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

test.describe('ranges: what agreement catches', () => {
  test('islands across a minor gap', async ({ nf }) => {
    // The split-family trigger. mfe-b's strict `~22.0.5` pin drags the shared core DOWN to its own
    // build, while router — which mfe-b does not ship — resolves freely to mfe-a's 22.1.0. mfe-a would
    // then run router@22.1.0 against a deduped core@22.0.5, so it serves its whole family itself.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-b/@angular/core.js');
    expect(map.scopes?.[SCOPE.a]).toEqual({
      '@angular/core': 'http://mfe-a/@angular/core.js',
      '@angular/router': 'http://mfe-a/@angular/router.js',
    });
    // router had no second provider, so it leaves the shared set with mfe-a's copy.
    expect(map.imports['@angular/router']).toBeUndefined();
    expect(await nf.islands()).toEqual(['team/mfe-a mixes @angular/core 22.0.5 vs 22.1.0']);

    // The fix, at runtime: neither remote runs a mixed family.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe-a']!.seen).toEqual({
      '@angular/core': 'mfe-a|@angular/core@22.1.0',
      '@angular/router': 'mfe-a|@angular/router@22.1.0',
    });
    expect(loaded['team/mfe-b']!.seen).toEqual({ '@angular/core': 'mfe-b|@angular/core@22.0.5' });
  });

  test('names the member and both tags in a single warning', async ({ nf }) => {
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]),
    ]);

    // The island warning already explains why router lost its last provider, so `warnIfScopedOnly`
    // must not restate that effect.
    expect(await nf.warns()).toEqual([
      expect.stringContaining(
        "'team/mfe-a' is islanded: the builds it draws on disagree on '@angular/core' (22.0.5 vs 22.1.0), so all 2 members of the pool are scoped for it."
      ),
    ]);
  });

  test('islands a remote whose own build disagrees even when its range accepts the shared tag', async ({
    nf,
  }) => {
    // `strictVersion: false` means "accept whatever is shared", so the resolver grants this remote a
    // dedup of core@22.1.0 despite its own 21.2.18. It also solely provides animations@21.2.18 — so
    // taking that dedup would run Angular 21 animations against an Angular 22 core. The declared range
    // cannot discriminate here; the minor line can, and does.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/legacy', SCOPE.legacy, [
        dep('@angular/core', '21.2.18', { req: '^21.0.0', strict: false }),
        dep('@angular/animations', '21.2.18', { req: '^21.0.0', strict: false }),
      ]),
    ]);

    const map = await nf.map();
    expect(await nf.islands()).toEqual(['team/legacy mixes @angular/core 21.2.18 vs 22.1.0']);
    expect(map.imports['@angular/animations']).toBeUndefined();
    expect(map.scopes?.[SCOPE.legacy]).toEqual({
      '@angular/core': 'http://legacy/@angular/core.js',
      '@angular/animations': 'http://legacy/@angular/animations.js',
    });
    expect((await nf.loadAll())['team/legacy']!.seen).toEqual({
      '@angular/core': 'legacy|@angular/core@21.2.18',
      '@angular/animations': 'legacy|@angular/animations@21.2.18',
    });
  });

  test('islands across a major gap, whole family', async ({ nf }) => {
    // The oldest case: the range violation is real, so the incompatible remote gets no dedup at all —
    // not even of `@angular/router`, which matches version-for-version at its own major.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/router', '18.0.0'),
      ]),
      remote('team/legacy', SCOPE.legacy, [
        dep('@angular/core', '17.0.0'),
        dep('@angular/router', '17.0.0'),
      ]),
    ]);

    expect(await nf.islands()).toEqual(['team/legacy on @angular/core@17.0.0']);
    expect((await nf.map()).scopes?.[SCOPE.legacy]).toEqual({
      '@angular/core': 'http://legacy/@angular/core.js',
      '@angular/router': 'http://legacy/@angular/router.js',
    });
  });

  test('dedups a pin that actually fits', async ({ nf }) => {
    // Not every pin splits a family. `~22.0.5` accepts every 22.0.x from 22.0.5 up, so the majority's
    // 22.0.8 satisfies it: the pinning remote dedups and nothing is scoped. Reproducing the split
    // needs a *minor* gap, which is what the case above uses.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
        dep('@angular/router', '22.0.8', { req: '~22.0.3' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [dep('@angular/core', '22.0.8', { req: '~22.0.5' })]),
    ]);

    expect((await nf.map()).scopes).toBeUndefined();
    expect(await nf.islands()).toEqual([]);
  });

  test('islands on mutually exclusive pins, with no major gap anywhere', async ({ nf }) => {
    // Incompatibility is not the same thing as a major gap. mfe-b pins each member exactly at 22.0.5
    // and mfe-a's `~22.1.0` cannot reach down to it, so neither range accepts the other's tag: the
    // election is a tie on copies, the newest tag takes it, and mfe-b is islanded on a patch-level
    // conflict inside one major.
    //
    // Note which pin loses. An exact pin only wins the election when the *others* can accept it — with
    // `^22.0.0` on mfe-a it would have dragged the shared core down to 22.0.5 instead.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.1.0', { req: '~22.1.0' }),
        dep('@angular/router', '22.1.0', { req: '~22.1.0' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [
        dep('@angular/core', '22.0.5', { req: '22.0.5' }),
        dep('@angular/router', '22.0.5', { req: '22.0.5' }),
      ]),
    ]);

    expect(await nf.islands()).toEqual(['team/mfe-b on @angular/core@22.0.5']);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(map.scopes?.[SCOPE.b]).toEqual({
      '@angular/core': 'http://mfe-b/@angular/core.js',
      '@angular/router': 'http://mfe-b/@angular/router.js',
    });
    expect((await nf.loadAll())['team/mfe-b']!.seen).toEqual({
      '@angular/core': 'mfe-b|@angular/core@22.0.5',
      '@angular/router': 'mfe-b|@angular/router@22.0.5',
    });
  });
});
