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
    expect(cold.scopes?.[SCOPE.mfe2]).toBeDefined();

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
    // Note WHICH side islands. Neither build serves the other remote and nobody agrees with either, so
    // round 1 is a tie — and a tie goes to the build the stored record already elected. mfe1 keeps the
    // global map and the newcomer runs its own family; the gate pipeline flipped to the newcomer instead.
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
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
      '@angular/router': 'http://mfe2/@angular/router.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe2 incompatible']);

    // Four URLs in the map, and on a cold browser cache all four are fetched — "cached" in the
    // objective means "already in the import map", not "already in the browser".
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(4);
  });

  test('drops a stale subpool when the pool that formed it dissolves', async ({ nf }) => {
    // Only mfe1 tags the family, so its tag alone forms the pool (explicit tags only, no scope tags).
    // mfe2 and mfe4 pin core to ~22.0.9, so mfe1's 22.0.6 build cannot serve them; the 22.0.9 build cannot
    // serve mfe1 or mfe3 (no router). Two each, so the newer build wins round 1, and a later round places
    // mfe3 in mfe1's subpool, recording `servedBy: team/mfe1` on its copies.
    const mfe1 = (at: string, pool?: string) =>
      remote('team/mfe1', at, [
        dep('@angular/core', '22.0.6', { req: '^22.0.0', ...(pool && { pool }) }),
        dep('@angular/router', '22.0.6', { req: '^22.0.0', ...(pool && { pool }) }),
      ]);
    const others = () => [
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.9', { req: '~22.0.9' })]),
      remote('team/mfe4', SCOPE.mfe4, [dep('@angular/core', '22.0.9', { req: '~22.0.9' })]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep('@angular/core', '22.0.6', { req: '^22.0.0' }),
        dep('@angular/router', '22.0.6', { req: '^22.0.0' }),
      ]),
    ];
    const subpoolsOf = async (name: string) =>
      (await nf.store())['__GLOBAL__']![name]!.versions.flatMap(v =>
        v.remotes.filter(r => r.servedBy).map(r => `${r.name}>${r.servedBy}`)
      );

    await nf.init([mfe1(SCOPE.mfe1, 'ng'), ...others()], { pooling: false });
    expect(await subpoolsOf('@angular/core')).toContain('team/mfe3>team/mfe1');

    // mfe1 redeploys at a new URL without its tag. Only mfe1 is refetched; mfe3 stays cached, and the
    // pool is gone. Its subpool used to survive, pointing mfe3's core at mfe1's *new* build beside mfe3's
    // own router — a pair neither pooling nor plain resolution would hand it.
    await nf.init([mfe1(SCOPE.mfe5), ...others()], { pooling: false });

    expect(await subpoolsOf('@angular/core')).toEqual([]);
    expect(await subpoolsOf('@angular/router')).toEqual([]);
    expect((await nf.map()).scopes?.[SCOPE.mfe3]).toBeUndefined();
    expect((await nf.load('team/mfe3')).seen['@angular/core']).toBe('mfe2|@angular/core@22.0.9');
  });

  test('drops a stale subpool when every other remote leaves a pool that survives', async ({
    nf,
  }) => {
    // As above, but mfe3 tags the family too, so the pool outlives mfe1's departure with mfe3 as its
    // only remote. A one-remote pool used to return before rebuilding its members, so mfe3 stayed in the
    // subpool of a build that no longer ships the family.
    const subpoolsOf = async (name: string) =>
      (await nf.store())['__GLOBAL__']![name]!.versions.flatMap(v =>
        v.remotes.filter(r => r.servedBy).map(r => `${r.name}>${r.servedBy}`)
      );
    const mfe3 = remote('team/mfe3', SCOPE.mfe3, [
      dep('@angular/core', '22.0.6', { req: '^22.0.0', pool: 'ng' }),
      dep('@angular/router', '22.0.6', { req: '^22.0.0', pool: 'ng' }),
    ]);

    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [
          dep('@angular/core', '22.0.6', { req: '^22.0.0', pool: 'ng' }),
          dep('@angular/router', '22.0.6', { req: '^22.0.0', pool: 'ng' }),
        ]),
        // Pinned, two of them: the 22.0.9 build wins round 1 and mfe3 joins mfe1's subpool (see above).
        remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.9', { req: '~22.0.9' })]),
        remote('team/mfe4', SCOPE.mfe4, [dep('@angular/core', '22.0.9', { req: '~22.0.9' })]),
        mfe3,
      ],
      { pooling: false }
    );
    expect(await subpoolsOf('@angular/core')).toContain('team/mfe3>team/mfe1');

    // mfe1 and mfe2 redeploy at new URLs without the family; only mfe3's copies remain, still tagged.
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe5, [dep('rxjs', '7.8.1')]),
        remote('team/mfe2', SCOPE.mfe4, [dep('rxjs', '7.8.1')]),
        remote('team/mfe4', SCOPE.mfe2, [dep('rxjs', '7.8.1')]),
        mfe3,
      ],
      { pooling: false }
    );

    expect(await subpoolsOf('@angular/core')).toEqual([]);
    expect(await subpoolsOf('@angular/router')).toEqual([]);
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@22.0.6',
      '@angular/router': 'mfe3|@angular/router@22.0.6',
    });
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
  const base = () =>
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
    await nf.init([base()], { unlisted: [late] });

    await nf.initRemoteEntry(late.url);

    const delta = await nf.map();
    expect(delta.scopes?.[SCOPE.mfe4]).toEqual({
      '@angular/router': 'http://mfe4/@angular/router.js',
      '@angular/forms': 'http://mfe4/@angular/forms.js',
    });
    // forms is sole-provided by mfe4, but it is not published globally off a build that disagrees
    // with the committed one.
    expect(delta.imports['@angular/forms']).toBeUndefined();
    // The dynamic verdict lands in the record exactly as an init one does.
    expect(await nf.islands()).toEqual(['team/mfe4 uncovered']);
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
    await nf.init([base()], { unlisted: [late] });

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

  test('islands patch drift on the dynamic path too', async ({ nf }) => {
    // Rewritten deliberately, and the point is that the gate is *still* the same predicate as on the init
    // path. What the old promise allowed: a committed build one patch away "agreed", so the late remote
    // deduped router@22.0.8 and served its own forms@22.0.5. What the new one requires: no build shipped
    // that pair, so mfe4 takes its own router too. Cost: one download more, and forms — which only mfe4
    // provides — no longer enters the global map off a build nothing witnesses.
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
    expect(delta.scopes?.[SCOPE.mfe4]).toEqual({
      '@angular/router': 'http://mfe4/@angular/router.js',
      '@angular/forms': 'http://mfe4/@angular/forms.js',
    });
    expect(delta.imports['@angular/forms']).toBeUndefined();
    expect((await nf.load('team/mfe4')).seen).toEqual({
      '@angular/router': 'mfe4|@angular/router@22.0.5',
      '@angular/forms': 'mfe4|@angular/forms@22.0.5',
    });
  });

  /**
   * Formerly a characterised defect: `pool-dynamic-externals` decided `scope` only in the *actions* it hands
   * to the import-map builder, while the store kept what `update-cache` had written — the loaded remote's
   * sole-provided member as `share`, its refused dedup as `skip`. The delta was right, but the next init
   * that did not re-elect this pool (a plain reload) rebuilt the map from the store and published that
   * member globally beside the committed family: #63's crash shape re-entering through the dynamic path.
   *
   * The dynamic step now writes the loaded remote's verdicts into the record, as `rebuildMember` does on
   * the init path, so the store says what the delta did.
   */
  test.describe('the dynamic island is persisted', () => {
    const late = () =>
      remote('team/mfe4', SCOPE.mfe4, [
        dep('@angular/router', '22.0.5', { req: '^22.0.0' }),
        dep('@angular/forms', '22.0.5', { req: '^22.0.0' }),
      ]);

    test('records the sole-provided member and the refused dedup as scoped', async ({ nf }) => {
      await nf.init([base()], { unlisted: [late()] });
      await nf.initRemoteEntry(late().url);

      const store = await nf.store();
      // Nothing publishes forms any more — the delta served mfe4 its own — and the dedup pooling
      // refused is a `scope` beside the committed share, not a `skip`.
      expect(storedActions(store, '@angular/forms')).toEqual(['22.0.5:scope']);
      expect(storedActions(store, '@angular/router')).toEqual(['22.1.0:share', '22.0.5:scope']);

      const causes = store['__GLOBAL__']!['@angular/forms']!.versions.flatMap(v =>
        v.remotes.map(r => r.poolCause)
      );
      expect(causes).toEqual(['uncovered']);
    });

    test('reproduces the delta on the next reload', async ({ nf }) => {
      await nf.init([base()], { unlisted: [late()] });
      await nf.initRemoteEntry(late().url);

      // A reload: same manifest, everything cached, so nothing is dirty and pooling is skipped.
      await nf.init([base()], { unlisted: [late()] });

      // mfe4 keeps its own family under its own scope, and nothing leaks into the global `imports`.
      const map = await nf.map();
      expect(map.imports['@angular/forms']).toBeUndefined();
      expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
      expect((await nf.load('team/mfe4')).seen).toEqual({
        '@angular/router': 'mfe4|@angular/router@22.0.5',
        '@angular/forms': 'mfe4|@angular/forms@22.0.5',
      });
      expect(await nf.resolve('@angular/forms', SCOPE.mfe1)).toContain('UNRESOLVED');
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
  const base = () =>
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
    await nf.init([base()], { unlisted: [late()] });
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
    await nf.init([base()], { unlisted: [dedupable] });
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
    await nf.init([base()], { shim: true, unlisted: [late()] });
    await nf.initRemoteEntry(late().url);

    expect(await nf.maps()).toHaveLength(2);
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@18.0.0',
      '@angular/common': 'mfe3|@angular/common@18.0.0',
    });
  });
});
