import { test, expect, storedActions } from '../harness/federation';
import { dep, remote, SCOPE } from '../harness/portfolio';

/**
 * Pooling across page loads and after the map is committed.
 *
 * Every `nf.init` here is a real page load against the same `sessionStorage`, so a second init is
 * literally the warm start a user gets on refresh — not a re-run of the flow over a seeded repository.
 */
test.describe('lifecycle: the warm start', () => {
  const splitFamily = () => [
    remote('team/mfe1', SCOPE.mfe1, [
      dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
      dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
    ]),
    remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]),
  ];

  test('reproduces a pooled map on reload, without refetching or rewriting', async ({ nf }) => {
    // Pooling writes its verdicts into the shared-externals record, so a warm init must rebuild the
    // same map from them without re-deciding anything. This is what makes skipping the step on a warm
    // init safe (#63): `determine` hands pooling only the externals it re-elected.
    await nf.init(splitFamily());
    const cold = await nf.map();
    expect(cold.scopes?.[SCOPE.mfe1]).toBeDefined();

    await nf.init(splitFamily());

    expect(nf.fetches()).toEqual([]);
    expect(await nf.writes()).toEqual([]);
    expect(await nf.map()).toEqual(cold);

    // And the map the browser gets is not merely equal — it works: the reloaded page resolves the
    // family exactly as the cold one did.
    expect((await nf.loadAll())['team/mfe1']!.seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.1.0',
      '@angular/router': 'mfe1|@angular/router@22.1.0',
    });
  });

  test('reproduces a healthy map on reload', async ({ nf }) => {
    // The other half of the claim: when pooling islands nobody it must also leave nothing behind that a
    // second pass would decide differently.
    const healthy = () => [
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '17.0.1', { req: '^17.0.0' }),
        dep('@angular/material', '17.0.1', { req: '^17.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '17.0.0', { req: '^17.0.0' })]),
    ];

    await nf.init(healthy());
    const cold = await nf.map();
    expect(cold.scopes).toBeUndefined();

    await nf.init(healthy());

    expect(await nf.map()).toEqual(cold);
    expect(nf.fetches()).toEqual([]);
  });

  test('re-pools when a new remote joins a cached portfolio', async ({ nf }) => {
    // The incremental case: the first init is coherent and islands nobody. Adding a cross-major remote
    // makes its members dirty, so determine re-elects them and pooling runs again — the cached remote
    // is re-read from storage, not refetched.
    //
    // Note WHICH side islands. `generate-import-map` marked mfe1's copies `cached` when it served
    // them, and the objective only counts *uncached* copies, so scoping mfe1 is free while scoping the
    // newcomer costs a download. The shared build therefore flips to the newcomer's 21.2.18 and mfe1
    // self-serves its already-cached family. That is the resolver's cache term, not the copy weighting
    // — and pooling's guarantee is unaffected: whoever islands, islands whole.
    const first = [
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.0.8', { req: '^22.0.0' }),
        dep('@angular/router', '22.0.8', { req: '^22.0.0' }),
      ]),
    ];
    await nf.init(first);
    expect((await nf.map()).scopes).toBeUndefined();

    const late = remote('team/mfe2', SCOPE.mfe2, [
      dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
      dep('@angular/router', '21.2.18', { req: '~21.2.0' }),
    ]);
    await nf.init([...first, late]);

    expect(nf.fetches()).toEqual([late.url]);
    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe2/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe2/@angular/router.js');
    expect(map.scopes?.[SCOPE.mfe1]).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
      '@angular/router': 'http://mfe1/@angular/router.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe1 on @angular/core@22.0.8']);

    // Four URLs in the map, and on a cold browser cache all four are fetched — "cached" in the
    // objective means "already in the import map", not "already in the browser".
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(4);
  });

  test('keeps an island out of the shared set it was islanded from', async ({ nf }) => {
    // What "the verdicts survive" means concretely: after the round-trip the islanded remote's copies
    // are stored as `scope` and its sole-provided member has no shared version, so no later pass can
    // resurrect them.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
        dep('@angular/router', '22.0.8', { req: '~22.0.3' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        dep('@angular/animations', '21.2.18', { req: '~21.2.0' }),
      ]),
    ]);

    const stored = await nf.store();
    expect(storedActions(stored, '@angular/core')).toEqual(['22.0.8:share', '21.2.18:scope']);
    expect(storedActions(stored, '@angular/animations')).toEqual(['21.2.18:scope']);

    const cold = await nf.map();
    await nf.init([]);
    expect(await nf.map()).toEqual(cold);
  });

  test('rebuilds the same map from a manifest URL as from a manifest object', async ({ nf }) => {
    // The manifest can arrive either way; both must produce the same import map. The URL form is one
    // more real fetch, which is the only difference the browser sees.
    const portfolio = () => [
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]),
    ];

    await nf.init(portfolio(), { namespace: 'object' });
    const fromObject = await nf.map();

    await nf.init(portfolio(), { namespace: 'url', manifestFromUrl: true });

    expect(await nf.map()).toEqual(fromObject);
  });
});

/**
 * The dynamic path — a remote loaded at runtime, after the import map is already committed — is
 * strictly additive.
 *
 * The committed import map is immutable, so nothing already served can be re-pointed: the newly loaded
 * remote is the only thing that can move. Both gates are mirrored onto it — a remote that cannot take a
 * coherent family from the committed builds serves its whole family from its own build instead.
 *
 * These run on native import maps. Chromium honours a second `<script type="importmap">` and merges it
 * into the first, so the delta really does take effect — but a merge cannot *replace* an existing entry,
 * which is the browser-level reason the delta has to be additive. The last block in this file pins both
 * halves of that, and the es-module-shims configuration alongside it.
 */
test.describe('lifecycle: the dynamic path', () => {
  const anchor = () =>
    remote('team/mfe1', SCOPE.mfe1, [
      dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
      dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
    ]);

  test('islands a remote that is incompatible with the committed family', async ({ nf }) => {
    const late = remote('team/mfe3', SCOPE.mfe3, [
      dep('@angular/core', '18.0.0', { req: '^18.0.0' }),
      dep('@angular/common', '18.0.0', { req: '^18.0.0' }),
    ]);
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [
          dep('@angular/core', '17.0.0', { req: '^17.0.0' }),
          dep('@angular/common', '17.0.0', { req: '^17.0.0' }),
        ]),
      ],
      { unlisted: [late] }
    );
    const [committed] = await nf.maps();

    await nf.initRemoteEntry(late.url);

    // The delta serves the new remote's whole family from its own scope and adds nothing global.
    const delta = await nf.map();
    expect(delta.scopes?.[SCOPE.mfe3]).toEqual({
      '@angular/core': 'http://mfe3/@angular/core.js',
      '@angular/common': 'http://mfe3/@angular/common.js',
    });
    expect(delta.imports['@angular/core']).toBeUndefined();
    expect(delta.imports['@angular/common']).toBeUndefined();

    // The committed map is untouched — that is the additive-only guarantee.
    expect(committed!.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(committed!.scopes).toBeUndefined();

    // And the browser honours both maps at once: the late remote runs its own 18 family while the
    // original keeps the shared 17 one.
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@18.0.0',
      '@angular/common': 'mfe3|@angular/common@18.0.0',
    });
    expect((await nf.load('team/mfe1')).seen['@angular/core']).toBe('mfe1|@angular/core@17.0.0');
  });

  test('islands a remote whose own build disagrees with the committed one', async ({ nf }) => {
    // The agreement gate, mirrored. mfe4's router is compatible with the committed router@22.1.0
    // (^22.0.0 accepts it) so the resolver grants the dedup — but taking it would leave mfe4 running
    // router@22.1.0 against its own forms@22.0.5, a family split across a minor line.
    const late = remote('team/mfe4', SCOPE.mfe4, [
      dep('@angular/router', '22.0.5', { req: '^22.0.0' }),
      dep('@angular/forms', '22.0.5', { req: '^22.0.0' }),
    ]);
    await nf.init([anchor()], { unlisted: [late] });

    await nf.initRemoteEntry(late.url);

    const delta = await nf.map();
    expect(delta.scopes?.[SCOPE.mfe4]).toEqual({
      '@angular/router': 'http://mfe4/@angular/router.js',
      '@angular/forms': 'http://mfe4/@angular/forms.js',
    });
    // forms is sole-provided by mfe4, but it is not published globally off a build that disagrees
    // with the committed one.
    expect(delta.imports['@angular/forms']).toBeUndefined();
    expect(await nf.warns()).toContainEqual(
      expect.stringContaining(
        "the committed builds serving this family disagree on '@angular/router' (22.0.5 vs 22.1.0), so all 2 pooled members are scoped for it."
      )
    );
    expect((await nf.load('team/mfe4')).seen).toEqual({
      '@angular/router': 'mfe4|@angular/router@22.0.5',
      '@angular/forms': 'mfe4|@angular/forms@22.0.5',
    });
  });

  test('lets a remote dedup a family it agrees with', async ({ nf }) => {
    // Same shape, but mfe4's build sits on the committed minor line, so both gates pass and it dedups
    // the whole family — the delta carries no framework entry of its own at all.
    const late = remote('team/mfe4', SCOPE.mfe4, [
      dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
      dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
    ]);
    await nf.init([anchor()], { unlisted: [late] });

    await nf.initRemoteEntry(late.url);

    const delta = await nf.map();
    expect(delta.scopes).toBeUndefined();
    expect(delta.imports['team/mfe4/./comp']).toBe('http://mfe4/comp.js');
    expect(await nf.islands()).toEqual([]);

    // The dedup, at runtime: the late remote reuses the copies already on the page.
    await nf.load('team/mfe1');
    const before = await nf.copies();
    expect((await nf.load('team/mfe4')).seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.1.0',
      '@angular/router': 'mfe1|@angular/router@22.1.0',
    });
    expect(await nf.copies()).toEqual(before);
  });

  test('tolerates patch drift on the dynamic path too', async ({ nf }) => {
    // The gate is the same predicate as on the init path: a build one patch away agrees, so the late
    // remote dedups rather than islanding.
    const late = remote('team/mfe4', SCOPE.mfe4, [
      dep('@angular/router', '22.0.5', { req: '^22.0.0' }),
      dep('@angular/forms', '22.0.5', { req: '^22.0.0' }),
    ]);
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [
          dep('@angular/core', '22.0.8', { req: '^22.0.0' }),
          dep('@angular/router', '22.0.8', { req: '^22.0.0' }),
        ]),
      ],
      { unlisted: [late] }
    );

    await nf.initRemoteEntry(late.url);

    const delta = await nf.map();
    expect(delta.scopes).toBeUndefined();
    expect(delta.imports['@angular/forms']).toBe('http://mfe4/@angular/forms.js');
    expect(await nf.warns()).toEqual([]);
    expect((await nf.load('team/mfe4')).seen).toEqual({
      '@angular/router': 'mfe1|@angular/router@22.0.8',
      '@angular/forms': 'mfe4|@angular/forms@22.0.5',
    });
  });

  /**
   * CHARACTERISATION — a defect found while writing this suite, not a documented decision.
   *
   * `pool-dynamic-externals` decides `scope` in the *actions* it hands to the import-map builder, but
   * the store has already been written by `update-cache`: the loaded remote's sole-provided member is
   * committed as `share` from its own build. The delta the browser receives is correct, so nothing is
   * broken in this session — but the persisted state disagrees with it, and the next init that does not
   * re-elect this pool (a plain reload, where nothing is dirty and pooling is skipped) rebuilds the map
   * from the store and publishes that member globally, with the disagreeing dedup restored.
   *
   * That is #63's crash shape re-entering through the dynamic path. Fixing it means recording the
   * island in the store — pooling's init path does exactly that in `rebuildMember`.
   */
  test.describe('known defect: the dynamic island is not persisted', () => {
    const late = () =>
      remote('team/mfe4', SCOPE.mfe4, [
        dep('@angular/router', '22.0.5', { req: '^22.0.0' }),
        dep('@angular/forms', '22.0.5', { req: '^22.0.0' }),
      ]);

    test('commits the sole-provided member as shared even though it was scoped', async ({ nf }) => {
      await nf.init([anchor()], { unlisted: [late()] });
      await nf.initRemoteEntry(late().url);

      // The map served mfe4 its own forms (asserted above), but the store says it is shared globally.
      const store = await nf.store();
      expect(storedActions(store, '@angular/forms')).toEqual(['22.0.5:share']);
      // ...and the dedup pooling refused is still recorded as a plain `skip`, not a `scope`.
      expect(storedActions(store, '@angular/router')).toEqual(['22.1.0:share', '22.0.5:skip']);
    });

    test('resurrects the incoherent map on the next reload', async ({ nf }) => {
      await nf.init([anchor()], { unlisted: [late()] });
      await nf.initRemoteEntry(late().url);

      // A reload: same manifest, everything cached, so nothing is dirty and pooling is skipped.
      await nf.init([anchor()], { unlisted: [late()] });

      // forms@22.0.5 is now global beside router@22.1.0, and mfe4 has no scope of its own — the exact
      // mix the dynamic gate refused one page load earlier.
      const map = await nf.map();
      expect(map.imports['@angular/forms']).toBe('http://mfe4/@angular/forms.js');
      expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
      expect(map.scopes).toBeUndefined();

      // And it is reachable: any remote's code now resolves the mixed pair.
      expect(await nf.resolve('@angular/forms', SCOPE.mfe1)).toBe('mfe4|@angular/forms@22.0.5');
      expect(await nf.resolve('@angular/router', SCOPE.mfe1)).toBe('mfe1|@angular/router@22.1.0');
    });
  });
});

/**
 * Why the dynamic path has to be additive, pinned at the level where the constraint actually lives.
 *
 * The library commits the init map with `override: true` and every later delta without it, so the
 * document ends up with several `<script type="importmap">` elements. Chromium merges them — the delta
 * genuinely takes effect — but a merge cannot *replace* a mapping the first map already made, so a
 * remote already being served can never be re-pointed. That, not a library choice, is why the newly
 * loaded remote is the only thing a dynamic init can move.
 */
test.describe('lifecycle: how the browser treats a second import map', () => {
  const anchor = () =>
    remote('team/mfe1', SCOPE.mfe1, [
      dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
      dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
    ]);
  const late = () =>
    remote('team/mfe3', SCOPE.mfe3, [
      dep('@angular/core', '18.0.0', { req: '^18.0.0' }),
      dep('@angular/common', '18.0.0', { req: '^18.0.0' }),
    ]);

  test('merges the delta into the committed map', async ({ nf }) => {
    await nf.init([anchor()], { unlisted: [late()] });
    await nf.initRemoteEntry(late().url);

    // Two separate maps in the document, the second carrying only the delta...
    const maps = await nf.maps();
    expect(maps).toHaveLength(2);
    expect(maps[0]!.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(maps[0]!.scopes).toBeUndefined();
    expect(maps[1]!.imports['@angular/core']).toBeUndefined();
    expect(maps[1]!.scopes?.[SCOPE.mfe3]).toEqual({
      '@angular/core': 'http://mfe3/@angular/core.js',
      '@angular/common': 'http://mfe3/@angular/common.js',
    });

    // ...and the browser resolves against the union: the late remote gets its island, while the remote
    // already served keeps the mapping the first map gave it.
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@18.0.0',
      '@angular/common': 'mfe3|@angular/common@18.0.0',
    });
    expect(await nf.resolve('@angular/core', SCOPE.mfe1)).toBe('mfe1|@angular/core@22.1.0');
  });

  test('never re-declares a specifier the committed map already serves', async ({ nf }) => {
    // The invariant that keeps the library on the right side of that merge rule. The delta may add
    // global imports for members nobody served yet, but it must never restate one that is already
    // mapped — a restatement would be silently ignored, so the two maps would disagree about what the
    // page is running.
    const dedupable = remote('team/mfe4', SCOPE.mfe4, [
      dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
      dep('@angular/forms', '22.1.0', { req: '^22.0.0' }),
    ]);
    await nf.init([anchor()], { unlisted: [dedupable] });
    await nf.initRemoteEntry(dedupable.url);

    const [committed, delta] = await nf.maps();
    const restated = Object.keys(delta!.imports).filter(key => key in committed!.imports);
    expect(restated).toEqual([]);

    // forms had no provider before, so publishing it globally is additive and does take effect.
    expect(delta!.imports['@angular/forms']).toBe('http://mfe4/@angular/forms.js');
    expect(await nf.resolve('@angular/forms', SCOPE.mfe1)).toBe('mfe4|@angular/forms@22.1.0');
  });

  test('works the same way through the es-module-shims configuration', async ({ nf }) => {
    // `useShimImportMap({ shimMode: true })` writes `importmap-shim` scripts and resolves through
    // `importShim` instead of the browser's own resolver. Same verdicts, different machinery.
    await nf.init([anchor()], { shim: true, unlisted: [late()] });
    await nf.initRemoteEntry(late().url);

    expect(await nf.maps()).toHaveLength(2);
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@18.0.0',
      '@angular/common': 'mfe3|@angular/common@18.0.0',
    });
  });
});
