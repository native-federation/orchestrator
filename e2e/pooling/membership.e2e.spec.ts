import { test, expect, sharedTags } from '../harness/federation';
import { dep, remote, SCOPE } from '../harness/portfolio';

/**
 * Which externals a `remoteEntry` puts in the same family.
 *
 * Membership is the connected component of a graph with two kinds of edge: the npm scope of a package
 * name (auto-pooling, portfolio-global) and a declared `pool` tag (remote-local for membership, but
 * the gates then operate on the whole external). Everything else — how many builds a family may draw
 * on, who islands — only ever applies *within* one pool.
 *
 * Every case here varies one field of the declaration and nothing else.
 */
test.describe('membership: npm scope', () => {
  test('two npm scopes are two independent pools', async ({ nf }) => {
    // mfe-b is a major behind on @angular, so it islands that family — but @design is a different pool
    // and matches exactly, so mfe-b keeps deduping it. An island never spreads beyond its own family.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/router', '18.0.0'),
        dep('@design/ui', '1.0.0'),
        dep('@design/icons', '1.0.0'),
      ]),
      remote('team/mfe-b', SCOPE.b, [
        dep('@angular/core', '17.0.0'),
        dep('@angular/router', '17.0.0'),
        dep('@design/ui', '1.0.0'),
        dep('@design/icons', '1.0.0'),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@design/ui']).toBe('http://mfe-a/@design/ui.js');
    expect(map.imports['@design/icons']).toBe('http://mfe-a/@design/icons.js');
    expect(map.scopes?.[SCOPE.b]).toEqual({
      '@angular/core': 'http://mfe-b/@angular/core.js',
      '@angular/router': 'http://mfe-b/@angular/router.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe-b on @angular/core@17.0.0']);

    // What the island means at runtime: mfe-b's code runs its own framework and the shared design
    // system, and only one @design/ui was ever instantiated for the page.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe-b']!.seen).toEqual({
      '@angular/core': 'mfe-b|@angular/core@17.0.0',
      '@angular/router': 'mfe-b|@angular/router@17.0.0',
      '@design/ui': 'mfe-a|@design/ui@1.0.0',
      '@design/icons': 'mfe-a|@design/icons@1.0.0',
    });
    expect(await nf.buildsOf('@design/ui')).toEqual(['mfe-a|@design/ui@1.0.0']);
    expect(await nf.buildsOf('@angular/core')).toEqual([
      'mfe-a|@angular/core@18.0.0',
      'mfe-b|@angular/core@17.0.0',
    ]);
  });

  test('a pool of one member coordinates nothing', async ({ nf }) => {
    // Below two members there is nothing to coordinate: the per-external verdict is already coherent,
    // so the incompatible remote scopes just that member — identical to pooling being off.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [dep('@angular/core', '18.0.0')]),
      remote('team/mfe-b', SCOPE.b, [dep('@angular/core', '17.0.0')]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(map.scopes).toEqual({
      [SCOPE.b]: { '@angular/core': 'http://mfe-b/@angular/core.js' },
    });
    expect(await nf.islands()).toEqual([]);
  });

  test('an unscoped name is not auto-pooled, so its family can mix majors', async ({ nf }) => {
    // The status quo the `pool` tag exists to fix: with no tag and no npm scope, react and react-dom
    // are unrelated externals. mfe-b scopes the react it rejects and dedups react-dom@18.2.0 — react 17
    // against react-dom 18, which is exactly the split-family shape, just outside pooling's reach.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [dep('react', '18.2.0'), dep('react-dom', '18.2.0')]),
      remote('team/mfe-b', SCOPE.b, [dep('react', '17.0.2'), dep('react-dom', '18.2.0')]),
    ]);

    const map = await nf.map();
    expect(map.scopes?.[SCOPE.b]).toEqual({ react: 'http://mfe-b/react.js' });
    expect(map.imports['react-dom']).toBe('http://mfe-a/react-dom.js');
    expect(await nf.islands()).toEqual([]);

    // The hazard, observed rather than inferred: mfe-b's code really does get react 17 next to
    // react-dom 18.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe-b']!.seen).toEqual({
      react: 'mfe-b|react@17.0.2',
      'react-dom': 'mfe-a|react-dom@18.2.0',
    });
  });
});

test.describe('membership: the `pool` tag', () => {
  const tagged = (pool: string) => (pkg: string, version: string, req?: string) =>
    dep(pkg, version, { pool, ...(req ? { req } : {}) });

  test('joins two npm scopes into one family', async ({ nf }) => {
    // The design system declares itself part of the framework family, so an incompatible consumer can
    // no longer take the design system either — the case the two-pool test above deliberately allows.
    const ng = tagged('framework');
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [ng('@angular/core', '18.0.0'), ng('@design/ui', '1.0.0')]),
      remote('team/mfe-b', SCOPE.b, [ng('@angular/core', '17.0.0'), ng('@design/ui', '1.0.0')]),
    ]);

    expect((await nf.map()).scopes?.[SCOPE.b]).toEqual({
      '@angular/core': 'http://mfe-b/@angular/core.js',
      '@design/ui': 'http://mfe-b/@design/ui.js',
    });
    expect((await nf.loadAll())['team/mfe-b']!.seen['@design/ui']).toBe('mfe-b|@design/ui@1.0.0');
  });

  test('pools an unscoped lockstep family portfolio-wide from one remote’s tag', async ({ nf }) => {
    // The react/react-dom recipe. Auto-scoping only matches scoped npm names, so react can never be
    // auto-pooled — but a `pool` tag is remote-local for *membership* only, while the gates operate on
    // the whole external. One remote declaring `pool: 'react'` on both packages therefore pools the
    // family for every remote, including mfe-b which declared nothing.
    const react = tagged('react');
    await nf.init(
      [
        remote('team/mfe-a', SCOPE.a, [react('react', '18.2.0'), react('react-dom', '18.2.0')]),
        remote('team/mfe-b', SCOPE.b, [dep('react', '17.0.2'), dep('react-dom', '17.0.2')]),
      ],
      { pooling: false }
    );

    const map = await nf.map();
    expect(map.imports['react']).toBe('http://mfe-a/react.js');
    expect(map.imports['react-dom']).toBe('http://mfe-a/react-dom.js');
    expect(map.scopes?.[SCOPE.b]).toEqual({
      react: 'http://mfe-b/react.js',
      'react-dom': 'http://mfe-b/react-dom.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe-b on react@17.0.2']);

    // The point of the recipe: neither remote ends up with a mismatched pair.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe-b']!.seen).toEqual({
      react: 'mfe-b|react@17.0.2',
      'react-dom': 'mfe-b|react-dom@17.0.2',
    });
  });

  test('warns about a tag that pooled with nothing', async ({ nf }) => {
    // A tag nothing else joined is a typo or a missing sibling, and silently degrading to "no pool" is
    // exactly the failure #63 is about — so it is called out. Auto-scope singletons stay silent.
    await nf.init(
      [
        remote('team/mfe-a', SCOPE.a, [
          dep('@angular/core', '18.0.0', { pool: 'framwork' }),
          dep('@angular/router', '18.0.0'),
        ]),
        remote('team/mfe-b', SCOPE.b, [
          dep('@angular/core', '17.0.0'),
          dep('@angular/router', '18.0.0'),
        ]),
      ],
      { pooling: false }
    );

    expect(await nf.warns()).toContainEqual(
      expect.stringContaining(
        "[@angular/core] declares a 'pool' tag but no other external joined its pool"
      )
    );
    // And it really did not pool: mfe-b scopes only the member it rejects.
    expect((await nf.map()).scopes?.[SCOPE.b]).toEqual({
      '@angular/core': 'http://mfe-b/@angular/core.js',
    });
  });
});

test.describe('membership: shareScope and singleton', () => {
  test('pools each shareScope separately', async ({ nf }) => {
    // Externals in a named shareScope are resolved and pooled within that scope, and served through
    // per-remote import-map scopes rather than global imports. mfe-c dedups the family from mfe-a's
    // build; mfe-b is a major behind, so it is islanded and served from its own.
    const scoped = (pkg: string, version: string) => dep(pkg, version, { shareScope: 'widgets' });

    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        scoped('@angular/core', '18.0.0'),
        scoped('@angular/router', '18.0.0'),
      ]),
      remote('team/mfe-c', SCOPE.c, [
        scoped('@angular/core', '18.0.0'),
        scoped('@angular/router', '18.0.0'),
      ]),
      remote('team/mfe-b', SCOPE.b, [
        scoped('@angular/core', '17.0.0'),
        scoped('@angular/router', '17.0.0'),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBeUndefined();
    expect(map.scopes?.[SCOPE.c]).toEqual({
      '@angular/core': 'http://mfe-a/@angular/core.js',
      '@angular/router': 'http://mfe-a/@angular/router.js',
    });
    expect(map.scopes?.[SCOPE.b]).toEqual({
      '@angular/core': 'http://mfe-b/@angular/core.js',
      '@angular/router': 'http://mfe-b/@angular/router.js',
    });

    // The warning is tagged with the shareScope it happened in.
    expect(await nf.warns()).toContainEqual(
      expect.stringContaining('[widgets][pool:@angular/core]')
    );

    // A named share scope is served entirely through import-map scopes, so a remote outside it must
    // resolve nothing — mfe-c dedups mfe-a's build, but only because it declared the same scope.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe-c']!.seen['@angular/core']).toBe('mfe-a|@angular/core@18.0.0');
    expect(loaded['team/mfe-b']!.seen['@angular/core']).toBe('mfe-b|@angular/core@17.0.0');
    expect(await nf.resolve('@angular/core', SCOPE.host)).toContain('UNRESOLVED');
  });

  test('keeps the same package in two share scopes apart', async ({ nf }) => {
    // The same npm name in `__GLOBAL__` and in a named scope are two different externals, resolved and
    // pooled independently — so a major gap in one has no bearing on the other.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/core', '17.0.0', { shareScope: 'widgets' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/core', '17.0.0', { shareScope: 'widgets' }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(map.scopes?.[SCOPE.b]?.['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(await nf.islands()).toEqual([]);

    const store = await nf.store();
    expect(sharedTags(store)).toEqual({ '@angular/core': ['18.0.0'] });
    expect(sharedTags(store, 'widgets')).toEqual({ '@angular/core': ['17.0.0'] });
  });

  test('never pools a non-singleton external', async ({ nf }) => {
    // `singleton: false` means "every remote gets its own instance", so the external is scoped per
    // remote by construction. It is not shareable, so it cannot be a pool member and a major gap in it
    // islands nobody.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/state', '18.0.0', { singleton: false }),
      ]),
      remote('team/mfe-b', SCOPE.b, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/state', '17.0.0', { singleton: false }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(map.imports['@angular/state']).toBeUndefined();
    expect(map.scopes?.[SCOPE.a]).toEqual({ '@angular/state': 'http://mfe-a/@angular/state.js' });
    expect(map.scopes?.[SCOPE.b]).toEqual({ '@angular/state': 'http://mfe-b/@angular/state.js' });
    expect(await nf.islands()).toEqual([]);

    // Two live instances of a non-singleton is the contract, not a failure.
    await nf.loadAll();
    expect(await nf.buildsOf('@angular/state')).toEqual([
      'mfe-a|@angular/state@18.0.0',
      'mfe-b|@angular/state@17.0.0',
    ]);
    expect(await nf.buildsOf('@angular/core')).toEqual(['mfe-a|@angular/core@18.0.0']);
  });
});

test.describe('membership: multi-entrypoint packages', () => {
  test('serves every entrypoint of one package from one build', async ({ nf }) => {
    // A package declaring several entrypoints is one external. Whichever build wins must serve all of
    // them: `@angular/core` and `@angular/core/primitives/signals` from two builds is the same hazard
    // as two members of a family from two builds, one level down.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.0.8', {
          req: '~22.0.3',
          entrypoints: ['/primitives/signals', '/rxjs-interop'],
        }),
        dep('@angular/common', '22.0.8', { req: '~22.0.3', entrypoints: ['/http'] }),
      ]),
      remote('team/mfe-b', SCOPE.b, [
        dep('@angular/core', '22.0.6', {
          req: '~22.0.3',
          entrypoints: ['/primitives/signals', '/rxjs-interop'],
        }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports).toEqual({
      '@angular/core': 'http://mfe-a/@angular/core.js',
      '@angular/core/primitives/signals': 'http://mfe-a/@angular/core/primitives/signals.js',
      '@angular/core/rxjs-interop': 'http://mfe-a/@angular/core/rxjs-interop.js',
      '@angular/common': 'http://mfe-a/@angular/common.js',
      '@angular/common/http': 'http://mfe-a/@angular/common/http.js',
      'team/mfe-a/./comp': 'http://mfe-a/comp.js',
      'team/mfe-b/./comp': 'http://mfe-b/comp.js',
    });

    // mfe-b declared three entrypoints of core and gets all three from mfe-a's build.
    expect((await nf.loadAll())['team/mfe-b']!.seen).toEqual({
      '@angular/core': 'mfe-a|@angular/core@22.0.8',
      '@angular/core/primitives/signals': 'mfe-a|@angular/core@22.0.8',
      '@angular/core/rxjs-interop': 'mfe-a|@angular/core@22.0.8',
    });
  });

  test('moves every entrypoint into the island together', async ({ nf }) => {
    // The same all-or-nothing rule at entrypoint granularity: an islanded remote serves each declared
    // entrypoint from its own build, never a mix.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '18.0.0', { entrypoints: ['/testing'] }),
        dep('@angular/router', '18.0.0'),
      ]),
      remote('team/legacy', SCOPE.legacy, [
        dep('@angular/core', '17.0.0', { entrypoints: ['/testing'] }),
        dep('@angular/router', '17.0.0'),
      ]),
    ]);

    expect((await nf.map()).scopes?.[SCOPE.legacy]).toEqual({
      '@angular/core': 'http://legacy/@angular/core.js',
      '@angular/core/testing': 'http://legacy/@angular/core/testing.js',
      '@angular/router': 'http://legacy/@angular/router.js',
    });
    expect((await nf.loadAll())['team/legacy']!.seen).toEqual({
      '@angular/core': 'legacy|@angular/core@17.0.0',
      '@angular/core/testing': 'legacy|@angular/core@17.0.0',
      '@angular/router': 'legacy|@angular/router@17.0.0',
    });
  });
});
