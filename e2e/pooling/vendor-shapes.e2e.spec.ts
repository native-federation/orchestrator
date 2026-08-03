import { test, expect, type Federation, type Loaded } from '../harness/federation';
import {
  dep,
  poolFixture,
  remote,
  shape,
  shapeName,
  SHAPES,
  withChunks,
  SCOPE,
} from '../harness/portfolio';

/**
 * The **vendor setup**: the four shapes a built `remoteEntry.json` reaches the orchestrator in, and what
 * each one does to pooling.
 *
 * | axis        | dense                                                | flat                                                                        |
 * | ----------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
 * | `externals` | one `shared` element per package, `entries` map      | one `shared` element per **entrypoint**, `outFileName`                       |
 * | `chunking`  | a `chunks` property, keyed by bundle                 | each chunk an `@nf-internal/chunk-*` pseudo-external in `shared`             |
 *
 * Both flat forms are what older builders emit, and both are still in the field: of the eleven recorded
 * fixtures, `fixtures/mfe1` is flat/flat and `fixtures/mfe2` is flat externals with dense chunking.
 *
 * Two claims, and they are different in kind:
 *
 * 1. **The verdict is shape-invariant.** The same portfolio in any of the four shapes islands the same
 *    remote, emits the same import map and leaves each remote running the same builds. First block.
 * 2. **Where the shape does show through**, it is pinned exactly: `feature.convertFlatSharedInfo` decides
 *    whether a flat entry's entrypoints regroup into one external — and therefore whether entrypoint
 *    coverage exists at all — and flat chunking maps a chunk per *declaring* remote where dense chunking
 *    maps it per *serving* remote.
 */

/** `seen` reduced to what a shape cannot change: which origin's build, at which version. */
const builds = (loaded: Loaded) =>
  Object.fromEntries(
    Object.entries(loaded.seen).map(([specifier, id]) => [specifier, id.replace(/\|.+@/, '@')])
  );

/** Origins that served *any* entrypoint of `pkg` — the measure that survives regrouping. */
const originsServing = async (nf: Federation, pkg: string) =>
  [...new Set((await nf.copies()).filter(c => c.pkg.startsWith(pkg)).map(c => c.from))].sort();

/**
 * A split family with a chunk bundle. mfe1 ships {core, router} at 22.1.0 and one chunk; mfe2 pins core
 * at `~22.0.5`, drags the shared core to its own build, and ships no router — so mfe1 would run
 * router@22.1.0 against a deduped core@22.0.5 and is islanded instead.
 */
const splitFamily = () => [
  withChunks(
    remote('team/mfe1', SCOPE.mfe1, [
      dep('@angular/core', '22.1.0', {
        req: '^22.0.0',
        bundle: 'browser-ng',
        entrypoints: ['/testing'],
      }),
      dep('@angular/router', '22.1.0', { req: '^22.0.0', bundle: 'browser-ng' }),
    ]),
    { 'browser-ng': ['chunk-NG1.js'] }
  ),
  remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]),
];

/**
 * A ragged family nothing islands: three remotes on three patch tags of one minor line, each the sole
 * provider of one member.
 */
const raggedFamily = () => [
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
];

test.describe('shapes: the same verdict, whatever the build emitted', () => {
  test('really does serve four different documents', async () => {
    // The guard on the loop below: if `shape()` ever degraded to a no-op, eight tests would keep passing
    // while covering one shape. This asserts on the served document itself — `server.ts` publishes the
    // declaration verbatim minus `url`, so `JSON.stringify` is what the browser gets.
    const served = (s: Parameters<typeof shapeName>[0]) =>
      JSON.parse(JSON.stringify(shape(splitFamily()[0]!, s))) as {
        shared: Record<string, unknown>[];
        chunks?: Record<string, string[]>;
      };

    const dense = served({ externals: 'dense', chunking: 'dense' });
    expect(dense.chunks).toEqual({ 'browser-ng': ['chunk-NG1.js'] });
    expect(dense.shared).toHaveLength(2);
    expect(Object.keys(dense.shared[0]!['entries'] as object)).toEqual([
      '@angular/core',
      '@angular/core/testing',
    ]);

    const flat = served({ externals: 'flat', chunking: 'flat' });
    expect(flat.chunks).toBeUndefined();
    expect(flat.shared.every(entry => 'outFileName' in entry && !('entries' in entry))).toBe(true);
    expect(flat.shared.map(entry => entry['packageName'])).toEqual([
      '@angular/core',
      '@angular/core/testing',
      '@angular/router',
      '@nf-internal/chunk-NG1',
    ]);

    // And the two mixed shapes really are mixed.
    expect(served({ externals: 'flat', chunking: 'dense' }).chunks).toBeDefined();
    expect(served({ externals: 'dense', chunking: 'flat' }).shared).toHaveLength(3);
  });

  for (const s of SHAPES) {
    test(`islands the same remote on a split family — ${shapeName(s)}`, async ({ nf }) => {
      await nf.init(splitFamily().map(entry => shape(entry, s)));

      expect(await nf.islands()).toEqual([
        'team/mfe1 self-serves, no build covers @angular/core/testing',
      ]);

      const map = await nf.map();
      expect(map.imports['@angular/core']).toBe('http://mfe2/@angular/core.js');
      expect(map.imports['@angular/router']).toBeUndefined();
      expect(map.imports['@angular/core/testing']).toBeUndefined();
      // The island's whole family plus, in either chunking shape, its own chunk graph.
      expect(map.scopes?.[SCOPE.mfe1]).toEqual({
        '@angular/core': 'http://mfe1/@angular/core.js',
        '@angular/core/testing': 'http://mfe1/@angular/core/testing.js',
        '@angular/router': 'http://mfe1/@angular/router.js',
        '@nf-internal/chunk-NG1': 'http://mfe1/chunk-NG1.js',
      });

      const loaded = await nf.loadAll();
      expect(builds(loaded['team/mfe1']!)).toEqual({
        '@angular/core': 'mfe1@22.1.0',
        '@angular/core/testing': 'mfe1@22.1.0',
        '@angular/router': 'mfe1@22.1.0',
      });
      expect(builds(loaded['team/mfe2']!)).toEqual({ '@angular/core': 'mfe2@22.0.5' });
      expect(nf.chunkLoads()).toEqual(['http://mfe1/chunk-NG1.js']);
      expect(nf.downloads()).toHaveLength(4);
    });

    test(`shares a ragged family the same way — ${shapeName(s)}`, async ({ nf }) => {
      await nf.init(raggedFamily().map(entry => shape(entry, s)));

      expect(await nf.islands()).toEqual([]);
      const map = await nf.map();
      expect(map.scopes).toBeUndefined();
      expect(map.imports['@angular/core']).toBe('http://mfe3/@angular/core.js');
      expect(map.imports['@angular/only-1']).toBe('http://mfe1/@angular/only-1.js');
      expect(map.imports['@angular/only-2']).toBe('http://mfe2/@angular/only-2.js');
      expect(map.imports['@angular/only-3']).toBe('http://mfe3/@angular/only-3.js');

      const loaded = await nf.loadAll();
      expect(builds(loaded['team/mfe1']!)).toEqual({
        '@angular/core': 'mfe3@22.0.7',
        '@angular/only-1': 'mfe1@22.0.5',
      });
      expect(nf.downloads()).toHaveLength(4);
    });
  }
});

/**
 * `feature.convertFlatSharedInfo` regroups a flat `shared` array into one external per package, the way
 * `densifyExternals` does at build time. It is the only thing that makes a flat entry's entrypoints *one*
 * external — and entrypoint coverage (`entrypoints.e2e.spec.ts`) is a policy about one external's
 * entrypoints, so without the flag there is nothing for it to decide.
 *
 * The portfolio: two remotes bundle `@angular/material` + `/table`, a third also bundles `/sort`, all on
 * one tag. This is issue #61's shape.
 */
test.describe('shapes: flat externals and `convertFlatSharedInfo`', () => {
  const M = '@angular/material';
  const coverage = () =>
    [
      remote('team/mfe1', SCOPE.mfe1, [
        dep(M, '22.0.6', { req: '~22.0.6', entrypoints: ['/table'] }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep(M, '22.0.6', { req: '~22.0.6', entrypoints: ['/table'] }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep(M, '22.0.6', { req: '~22.0.6', entrypoints: ['/table', '/sort'] }),
      ]),
    ].map(entry => shape(entry, { externals: 'flat', chunking: 'dense' }));

  test('off, each entrypoint is its own external and the package tears across two builds', async ({
    nf,
  }) => {
    await nf.init(coverage(), { flatSharedInfo: false });

    // `@angular/material` and `@angular/material/sort` are unrelated externals here, so each elects its
    // own provider: the root and `/table` come from mfe1, `/sort` from mfe3. Nothing is wrong by the
    // resolver's lights — the tags match — but the page ends up running two builds of one package.
    const map = await nf.map();
    expect(map.imports[M]).toBe(`${SCOPE.mfe1}${M}.js`);
    expect(map.imports[`${M}/table`]).toBe(`${SCOPE.mfe1}${M}/table.js`);
    expect(map.imports[`${M}/sort`]).toBe(`${SCOPE.mfe3}${M}/sort.js`);

    await nf.loadAll();
    expect(await originsServing(nf, M)).toEqual(['mfe1', 'mfe3']);
    // And no gate reacts: the entrypoints are separate members of one auto-pool, agreeing on one tag.
    expect(await nf.islands()).toEqual([]);
  });

  test('on, the entrypoints regroup and the widest remote serves the whole package', async ({
    nf,
  }) => {
    await nf.init(coverage(), { flatSharedInfo: true });

    // Regrouped, the three entrypoints are one external with three `entries`, so the coverage policy
    // applies: mfe3 is elected as the serving basis because it is the only remote that covers everything.
    const map = await nf.map();
    expect(map.imports[M]).toBe(`${SCOPE.mfe3}${M}.js`);
    expect(map.imports[`${M}/table`]).toBe(`${SCOPE.mfe3}${M}/table.js`);
    expect(map.imports[`${M}/sort`]).toBe(`${SCOPE.mfe3}${M}/sort.js`);

    await nf.loadAll();
    expect(await originsServing(nf, M)).toEqual(['mfe3']);
  });

  test('leaves a dense entry untouched either way', async ({ nf }) => {
    // The flag only reaches flat input: `toDenseSharedInfoFormat` and `densifyExternals` agree on an entry
    // that already carries `entries`, so a modern build cannot be affected by the setting.
    const dense = () => [
      remote('team/mfe1', SCOPE.mfe1, [
        dep(M, '22.0.6', { req: '~22.0.6', entrypoints: ['/table'] }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep(M, '22.0.6', { req: '~22.0.6', entrypoints: ['/table', '/sort'] }),
      ]),
    ];

    await nf.init(dense(), { flatSharedInfo: false, namespace: 'off' });
    const off = await nf.map();

    await nf.init(dense(), { flatSharedInfo: true, namespace: 'on' });

    expect(await nf.map()).toEqual(off);
    expect(off.imports[`${M}/sort`]).toBe(`${SCOPE.mfe3}${M}/sort.js`);
  });
});

/**
 * Chunks are the one part of the map that is never global: they are mapped into the scope of the origin
 * that *serves* the file, not the remote that consumes the external — which is exactly what makes a
 * deduped external work. The consumer resolves `@angular/core` to the provider's URL, and the chunk import
 * inside that file then resolves against the provider's scope, because the importer is the file.
 *
 * The generated externals really do import their bundle's chunks in both shapes, so every assertion below
 * is about modules the browser actually fetched and evaluated.
 */
test.describe('shapes: dense chunking maps a chunk per serving remote', () => {
  const ng = (version: string, req: string) => [
    dep('@angular/core', version, { req, bundle: 'browser-ng' }),
    dep('@angular/router', version, { req, bundle: 'browser-ng' }),
  ];

  test('scopes a provider’s chunks to the provider, and a consumer resolves them anyway', async ({
    nf,
  }) => {
    await nf.init([
      withChunks(remote('team/mfe1', SCOPE.mfe1, ng('18.0.0', '^18.0.0')), {
        'browser-ng': ['chunk-NG1.js', 'chunk-NG2.js'],
      }),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '18.0.0', { req: '^18.0.0' })]),
    ]);

    // The chunk specifiers live under mfe1's scope only. mfe2, which dedups mfe1's core, gets none of its
    // own — it does not need any.
    const map = await nf.map();
    expect(map.scopes).toEqual({
      [SCOPE.mfe1]: {
        '@nf-internal/chunk-NG1': 'http://mfe1/chunk-NG1.js',
        '@nf-internal/chunk-NG2': 'http://mfe1/chunk-NG2.js',
      },
    });
    expect(Object.keys(map.imports).some(key => key.startsWith('@nf-internal/'))).toBe(false);

    // And it works: loading mfe2's module pulls mfe1's core, which pulls mfe1's chunks.
    expect((await nf.load('team/mfe2')).seen['@angular/core']).toBe('mfe1|@angular/core@18.0.0');
    expect(nf.chunkLoads()).toEqual(['http://mfe1/chunk-NG1.js', 'http://mfe1/chunk-NG2.js']);
  });

  test('gives an islanded remote its own chunk graph', async ({ nf }) => {
    // Both builds ship a bundle of the same name. The island serves its own external files, so its own
    // chunks must be mapped into its own scope — otherwise its core would resolve the shared build's chunk
    // and tear across versions inside a single package.
    await nf.init([
      withChunks(remote('team/mfe1', SCOPE.mfe1, ng('18.0.0', '^18.0.0')), {
        'browser-ng': ['chunk-NEW.js'],
      }),
      withChunks(remote('team/mfe2', SCOPE.mfe2, ng('17.0.0', '^17.0.0')), {
        'browser-ng': ['chunk-OLD.js'],
      }),
    ]);

    expect(await nf.islands()).toEqual(['team/mfe2 on @angular/core@17.0.0']);
    const map = await nf.map();
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
      '@angular/router': 'http://mfe2/@angular/router.js',
      '@nf-internal/chunk-OLD': 'http://mfe2/chunk-OLD.js',
    });
    expect(map.scopes?.[SCOPE.mfe1]).toEqual({
      '@nf-internal/chunk-NEW': 'http://mfe1/chunk-NEW.js',
    });

    await nf.loadAll();
    expect(nf.chunkLoads().sort()).toEqual([
      'http://mfe1/chunk-NEW.js',
      'http://mfe2/chunk-OLD.js',
    ]);
  });
});

/**
 * Flat chunking reaches the same runtime result by a different route: a chunk is declared as a
 * non-singleton external, so the resolver never shares it and every remote that declares one gets the
 * specifier mapped into its own scope — whether or not it serves anything.
 */
test.describe('shapes: flat chunking maps a chunk per declaring remote', () => {
  // Two remotes on one tag, each with a chunk bundle of its own. mfe2 dedups mfe1's core, so it serves no
  // external file at all — and therefore has no chunk to serve in the dense shape.
  const portfolio = () => [
    withChunks(
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0', bundle: 'browser-a' }),
      ]),
      { 'browser-a': ['chunk-A.js'] }
    ),
    withChunks(
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0', bundle: 'browser-b' }),
      ]),
      { 'browser-b': ['chunk-B.js'] }
    ),
  ];

  test('maps the deduping remote’s own chunk, which the dense shape leaves out', async ({ nf }) => {
    await nf.init(
      portfolio().map(entry => shape(entry, { externals: 'dense', chunking: 'dense' })),
      { namespace: 'dense' }
    );

    // Dense: only the serving remote's bundle is registered, because the map only needs the chunks of
    // files it actually points at.
    expect((await nf.map()).scopes).toEqual({
      [SCOPE.mfe1]: { '@nf-internal/chunk-A': 'http://mfe1/chunk-A.js' },
    });
    expect(await nf.resolve('@nf-internal/chunk-B', SCOPE.mfe2)).toContain('UNRESOLVED');

    await nf.init(
      portfolio().map(entry => shape(entry, { externals: 'dense', chunking: 'flat' })),
      { namespace: 'flat' }
    );

    // Flat: mfe2's chunk is a declared external of mfe2, so it is scoped for mfe2 even though mfe2's own
    // core file is never served.
    expect((await nf.map()).scopes).toEqual({
      [SCOPE.mfe1]: { '@nf-internal/chunk-A': 'http://mfe1/chunk-A.js' },
      [SCOPE.mfe2]: { '@nf-internal/chunk-B': 'http://mfe2/chunk-B.js' },
    });

    // Either way the running page is the same: one core build, and only the chunk of the file that was
    // actually served is fetched. The extra mapping is dead weight in the map, not a second download.
    expect((await nf.load('team/mfe2')).seen['@angular/core']).toBe('mfe1|@angular/core@22.1.0');
    expect(nf.chunkLoads()).toEqual(['http://mfe1/chunk-A.js']);

    // It is not a *wrong* mapping though: it resolves, to mfe2's own file. (Probing it downloads the
    // chunk, so this comes after the count above.)
    expect(await nf.resolve('@nf-internal/chunk-B', SCOPE.mfe2)).toBe('mfe2|chunk-B.js');
  });

  test('never lets a chunk pseudo-external join a pool', async ({ nf }) => {
    // `@nf-internal` looks exactly like an npm scope, so auto-pooling would group a build's chunks into a
    // family of their own if they ever reached the shared-externals repo. They cannot: a non-singleton
    // external is scoped per remote and never shareable, so `buildPools` never sees one.
    await nf.init(
      [
        withChunks(
          remote('team/mfe1', SCOPE.mfe1, [
            dep('@angular/core', '22.1.0', { req: '^22.0.0', bundle: 'browser-a' }),
            dep('@angular/router', '22.1.0', { req: '^22.0.0', bundle: 'browser-a' }),
          ]),
          { 'browser-a': ['chunk-A1.js', 'chunk-A2.js'] }
        ),
        withChunks(
          remote('team/mfe2', SCOPE.mfe2, [
            dep('@angular/core', '22.1.0', { req: '^22.0.0', bundle: 'browser-b' }),
            dep('@angular/router', '22.1.0', { req: '^22.0.0', bundle: 'browser-b' }),
          ]),
          { 'browser-b': ['chunk-B1.js'] }
        ),
      ].map(entry => shape(entry, { externals: 'flat', chunking: 'flat' }))
    );

    // The Angular family is pooled — so the walk did run — and no pool was formed for the chunks.
    const pools = (await nf.debugs()).filter(msg => msg.includes('[pool:'));
    expect(pools.some(msg => msg.includes('[pool:@angular/core]'))).toBe(true);
    expect(pools.some(msg => msg.includes('@nf-internal'))).toBe(false);

    // Nor is a chunk anywhere in the committed shared set.
    const shared = Object.keys((await nf.store())['__GLOBAL__'] ?? {});
    expect(shared.filter(name => name.startsWith('@nf-internal'))).toEqual([]);
    expect(shared.sort()).toEqual(['@angular/core', '@angular/router']);
  });
});

/**
 * The same shape as a recorded file rather than a generated one: `fixtures/pooling/` holds three entries
 * with flat externals, flat chunking and `pool` tags — the combination none of the eleven captured entries
 * has (the one flat/flat capture carries no tags).
 *
 * Auto-pooling is off throughout, so the declared tag is the only thing forming the family.
 */
test.describe('shapes: a recorded flat entry with `pool` tags', () => {
  const portfolio = () => [poolFixture(1), poolFixture(2), poolFixture(3)];

  test('islands the incompatible remote across the tagged family', async ({ nf }) => {
    await nf.init(portfolio(), { pooling: false });

    // mfe3's `~4.2.0` cannot accept the 4.3.2 the other two ship, so the tag scopes its whole family —
    // including `@acme/widgets`, which only mfe1 and mfe3 ship and which mfe3 would otherwise dedup.
    expect(await nf.islands()).toEqual(['team/mfe3 on @acme/platform@4.2.9']);

    const map = await nf.map();
    expect(map.imports['@acme/platform']).toBe('http://mfe1/_acme_platform.Bq1vX8kd7P.js');
    expect(map.imports['@acme/platform/forms']).toBe(
      'http://mfe1/_acme_platform_forms.Dm4tR0zqYw.js'
    );
    expect(map.imports['@acme/widgets']).toBe('http://mfe1/_acme_widgets.CxK9tLb2Vn.js');
    expect(map.scopes?.[SCOPE.mfe3]).toEqual({
      '@acme/platform': 'http://mfe3/_acme_platform.Yv2sN6hg8L.js',
      '@acme/platform/forms': 'http://mfe3/_acme_platform_forms.Rk8pJ3wdCz.js',
      '@acme/widgets': 'http://mfe3/_acme_widgets.Ja5xT9mkQr.js',
      '@nf-internal/chunk-B6HN1YFS': 'http://mfe3/chunk-B6HN1YFS.js',
    });
  });

  test('leaves the untagged unscoped member deduped, island or not', async ({ nf }) => {
    await nf.init(portfolio(), { pooling: false });

    // `rxjs` carries no tag and has no npm scope, so it is in no pool: the islanded remote still dedups it
    // from the majority. An island is scoped to the family it was islanded from, never to the remote.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe3']!.seen['rxjs']).toBe('mfe1|rxjs@7.8.2');
    expect(loaded['team/mfe3']!.seen['@acme/platform']).toBe('mfe3|@acme/platform@4.2.9');
    expect(loaded['team/mfe2']!.seen).toEqual({
      '@acme/platform': 'mfe1|@acme/platform@4.3.2',
      '@acme/platform/forms': 'mfe1|@acme/platform/forms@4.3.2',
      rxjs: 'mfe1|rxjs@7.8.2',
    });
    expect(await nf.buildsOf('rxjs')).toEqual(['mfe1|rxjs@7.8.2']);
  });

  test('maps each recorded chunk into its own remote’s scope', async ({ nf }) => {
    await nf.init(portfolio(), { pooling: false });

    // A recorded flat entry does not say which external imports which chunk — that relation lives in the
    // built file — so the check is the one the map can make: every declared chunk resolves from inside the
    // remote that declared it, and from nowhere else.
    const map = await nf.map();
    expect(Object.keys(map.imports).some(key => key.startsWith('@nf-internal/'))).toBe(false);
    expect(map.scopes?.[SCOPE.mfe1]).toEqual({
      '@nf-internal/chunk-4KJH2LMQ': 'http://mfe1/chunk-4KJH2LMQ.js',
      '@nf-internal/chunk-P7XD5RTB': 'http://mfe1/chunk-P7XD5RTB.js',
    });
    expect(await nf.resolve('@nf-internal/chunk-M2QW9VZC', SCOPE.mfe2)).toBe(
      'mfe2|chunk-M2QW9VZC.js'
    );
    expect(await nf.resolve('@nf-internal/chunk-M2QW9VZC', SCOPE.mfe1)).toContain('UNRESOLVED');
  });
});
