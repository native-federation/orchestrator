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
 * Every case here varies one field of the declaration and nothing else. Several run with auto-pooling
 * **off**, because that is how a `pool` tag is shown to form a family by itself — not a test of the flag,
 * which is `flag.e2e.spec.ts`. What the family then does with its version lines is `symmetric` and
 * `asymmetric`.
 */
test.describe('membership: npm scope', () => {
  test('two npm scopes are two independent pools', async ({ nf }) => {
    // mfe2 is a major behind on @angular, so it islands that family — but @design is a different pool
    // and matches exactly, so mfe2 keeps deduping it. An island never spreads beyond its own family.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/router', '18.0.0'),
        dep('@design/ui', '1.0.0'),
        dep('@design/icons', '1.0.0'),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '17.0.0'),
        dep('@angular/router', '17.0.0'),
        dep('@design/ui', '1.0.0'),
        dep('@design/icons', '1.0.0'),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@design/ui']).toBe('http://mfe1/@design/ui.js');
    expect(map.imports['@design/icons']).toBe('http://mfe1/@design/icons.js');
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
      '@angular/router': 'http://mfe2/@angular/router.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe2 on @angular/core@17.0.0']);

    // What the island means at runtime: mfe2's code runs its own framework and the shared design
    // system, and only one @design/ui was ever instantiated for the page.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe2']!.seen).toEqual({
      '@angular/core': 'mfe2|@angular/core@17.0.0',
      '@angular/router': 'mfe2|@angular/router@17.0.0',
      '@design/ui': 'mfe1|@design/ui@1.0.0',
      '@design/icons': 'mfe1|@design/icons@1.0.0',
    });
    expect(await nf.buildsOf('@design/ui')).toEqual(['mfe1|@design/ui@1.0.0']);
    expect(await nf.buildsOf('@angular/core')).toEqual([
      'mfe1|@angular/core@18.0.0',
      'mfe2|@angular/core@17.0.0',
    ]);
  });

  test('a pool of one member coordinates nothing', async ({ nf }) => {
    // Below two members there is nothing to coordinate: the per-external verdict is already coherent,
    // so the incompatible remote scopes just that member — identical to pooling being off.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [dep('@angular/core', '18.0.0')]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '17.0.0')]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.scopes).toEqual({
      [SCOPE.mfe2]: { '@angular/core': 'http://mfe2/@angular/core.js' },
    });
    expect(await nf.islands()).toEqual([]);
  });

  test('an unscoped name is not auto-pooled, so its family can mix majors', async ({ nf }) => {
    // The status quo the `pool` tag exists to fix: with no tag and no npm scope, react and react-dom
    // are unrelated externals. mfe2 scopes the react it rejects and dedups react-dom@18.2.0 — react 17
    // against react-dom 18, which is exactly the split-family shape, just outside pooling's reach.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [dep('react', '18.2.0'), dep('react-dom', '18.2.0')]),
      remote('team/mfe2', SCOPE.mfe2, [dep('react', '17.0.2'), dep('react-dom', '18.2.0')]),
    ]);

    const map = await nf.map();
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({ react: 'http://mfe2/react.js' });
    expect(map.imports['react-dom']).toBe('http://mfe1/react-dom.js');
    expect(await nf.islands()).toEqual([]);

    // The hazard, observed rather than inferred: mfe2's code really does get react 17 next to
    // react-dom 18.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe2']!.seen).toEqual({
      react: 'mfe2|react@17.0.2',
      'react-dom': 'mfe1|react-dom@18.2.0',
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
      remote('team/mfe1', SCOPE.mfe1, [ng('@angular/core', '18.0.0'), ng('@design/ui', '1.0.0')]),
      remote('team/mfe2', SCOPE.mfe2, [ng('@angular/core', '17.0.0'), ng('@design/ui', '1.0.0')]),
    ]);

    expect((await nf.map()).scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
      '@design/ui': 'http://mfe2/@design/ui.js',
    });
    expect((await nf.loadAll())['team/mfe2']!.seen['@design/ui']).toBe('mfe2|@design/ui@1.0.0');
  });

  test('pools an unscoped lockstep family portfolio-wide from one remote’s tag', async ({ nf }) => {
    // The react/react-dom recipe. Auto-scoping only matches scoped npm names, so react can never be
    // auto-pooled — but a `pool` tag is remote-local for *membership* only, while the gates operate on
    // the whole external. One remote declaring `pool: 'react'` on both packages therefore pools the
    // family for every remote, including mfe2 which declared nothing.
    const react = tagged('react');
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [react('react', '18.2.0'), react('react-dom', '18.2.0')]),
        remote('team/mfe2', SCOPE.mfe2, [dep('react', '17.0.2'), dep('react-dom', '17.0.2')]),
      ],
      { pooling: false }
    );

    const map = await nf.map();
    expect(map.imports['react']).toBe('http://mfe1/react.js');
    expect(map.imports['react-dom']).toBe('http://mfe1/react-dom.js');
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      react: 'http://mfe2/react.js',
      'react-dom': 'http://mfe2/react-dom.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe2 on react@17.0.2']);

    // The point of the recipe: neither remote ends up with a mismatched pair.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe2']!.seen).toEqual({
      react: 'mfe2|react@17.0.2',
      'react-dom': 'mfe2|react-dom@17.0.2',
    });
  });

  test('warns about a tag that pooled with nothing', async ({ nf }) => {
    // A tag nothing else joined is a typo or a missing sibling, and silently degrading to "no pool" is
    // exactly the failure #63 is about — so it is called out. Auto-scope singletons stay silent.
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [
          dep('@angular/core', '18.0.0', { pool: 'framwork' }),
          dep('@angular/router', '18.0.0'),
        ]),
        remote('team/mfe2', SCOPE.mfe2, [
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
    // And it really did not pool: mfe2 scopes only the member it rejects.
    expect((await nf.map()).scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
    });
  });
});

test.describe('membership: shareScope and singleton', () => {
  test('pools each shareScope separately', async ({ nf }) => {
    // Externals in a named shareScope are resolved and pooled within that scope, and served through
    // per-remote import-map scopes rather than global imports. mfe3 dedups the family from mfe1's
    // build; mfe2 is a major behind, so it is islanded and served from its own.
    const scoped = (pkg: string, version: string) => dep(pkg, version, { shareScope: 'widgets' });

    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        scoped('@angular/core', '18.0.0'),
        scoped('@angular/router', '18.0.0'),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        scoped('@angular/core', '18.0.0'),
        scoped('@angular/router', '18.0.0'),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        scoped('@angular/core', '17.0.0'),
        scoped('@angular/router', '17.0.0'),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBeUndefined();
    expect(map.scopes?.[SCOPE.mfe3]).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
      '@angular/router': 'http://mfe1/@angular/router.js',
    });
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
      '@angular/router': 'http://mfe2/@angular/router.js',
    });

    // The warning is tagged with the shareScope it happened in.
    expect(await nf.warns()).toContainEqual(
      expect.stringContaining('[widgets][pool:@angular/core]')
    );

    // A named share scope is served entirely through import-map scopes, so a remote outside it must
    // resolve nothing — mfe3 dedups mfe1's build, but only because it declared the same scope.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe3']!.seen['@angular/core']).toBe('mfe1|@angular/core@18.0.0');
    expect(loaded['team/mfe2']!.seen['@angular/core']).toBe('mfe2|@angular/core@17.0.0');
    expect(await nf.resolve('@angular/core', SCOPE.host)).toContain('UNRESOLVED');
  });

  test('keeps the same package in two share scopes apart', async ({ nf }) => {
    // The same npm name in `__GLOBAL__` and in a named scope are two different externals, resolved and
    // pooled independently — so a major gap in one has no bearing on the other.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/core', '17.0.0', { shareScope: 'widgets' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/core', '17.0.0', { shareScope: 'widgets' }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.scopes?.[SCOPE.mfe2]?.['@angular/core']).toBe('http://mfe1/@angular/core.js');
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
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/state', '18.0.0', { singleton: false }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/state', '17.0.0', { singleton: false }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/state']).toBeUndefined();
    expect(map.scopes?.[SCOPE.mfe1]).toEqual({ '@angular/state': 'http://mfe1/@angular/state.js' });
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({ '@angular/state': 'http://mfe2/@angular/state.js' });
    expect(await nf.islands()).toEqual([]);

    // Two live instances of a non-singleton is the contract, not a failure.
    await nf.loadAll();
    expect(await nf.buildsOf('@angular/state')).toEqual([
      'mfe1|@angular/state@18.0.0',
      'mfe2|@angular/state@17.0.0',
    ]);
    expect(await nf.buildsOf('@angular/core')).toEqual(['mfe1|@angular/core@18.0.0']);
  });
});

test.describe('membership: multi-entrypoint packages', () => {
  test('serves every entrypoint of one package from one build', async ({ nf }) => {
    // A package declaring several entrypoints is one external. Whichever build wins must serve all of
    // them: `@angular/core` and `@angular/core/primitives/signals` from two builds is the same hazard
    // as two members of a family from two builds, one level down.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.0.8', {
          req: '~22.0.3',
          entrypoints: ['/primitives/signals', '/rxjs-interop'],
        }),
        dep('@angular/common', '22.0.8', { req: '~22.0.3', entrypoints: ['/http'] }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.0.6', {
          req: '~22.0.3',
          entrypoints: ['/primitives/signals', '/rxjs-interop'],
        }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
      '@angular/core/primitives/signals': 'http://mfe1/@angular/core/primitives/signals.js',
      '@angular/core/rxjs-interop': 'http://mfe1/@angular/core/rxjs-interop.js',
      '@angular/common': 'http://mfe1/@angular/common.js',
      '@angular/common/http': 'http://mfe1/@angular/common/http.js',
      'team/mfe1/./comp': 'http://mfe1/comp.js',
      'team/mfe2/./comp': 'http://mfe2/comp.js',
    });

    // mfe2 declared three entrypoints of core and gets all three from mfe1's build.
    expect((await nf.loadAll())['team/mfe2']!.seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.0.8',
      '@angular/core/primitives/signals': 'mfe1|@angular/core@22.0.8',
      '@angular/core/rxjs-interop': 'mfe1|@angular/core@22.0.8',
    });
  });

  test('moves every entrypoint into the island together', async ({ nf }) => {
    // The same all-or-nothing rule at entrypoint granularity: an islanded remote serves each declared
    // entrypoint from its own build, never a mix.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '18.0.0', { entrypoints: ['/testing'] }),
        dep('@angular/router', '18.0.0'),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '17.0.0', { entrypoints: ['/testing'] }),
        dep('@angular/router', '17.0.0'),
      ]),
    ]);

    expect((await nf.map()).scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
      '@angular/core/testing': 'http://mfe2/@angular/core/testing.js',
      '@angular/router': 'http://mfe2/@angular/router.js',
    });
    expect((await nf.loadAll())['team/mfe2']!.seen).toEqual({
      '@angular/core': 'mfe2|@angular/core@17.0.0',
      '@angular/core/testing': 'mfe2|@angular/core@17.0.0',
      '@angular/router': 'mfe2|@angular/router@17.0.0',
    });
  });
});
