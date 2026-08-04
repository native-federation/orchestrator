import { test, expect, sharedTags } from '../harness/federation';
import { dep, remote, SCOPE, fixture, CAPTURED_SEVEN } from '../harness/portfolio';
import { angularLinesPerRemote, angularTags, splitPackages } from '../harness/coherence';

/**
 * `feature.useAutoExternalPooling` — the only file that switches it.
 *
 * Everywhere else in this folder pooling is on (or a `pool` tag forms the family regardless) and the
 * question is which verdict a portfolio gets. Here the portfolio is held fixed and the flag moves, so
 * every assertion is about the difference the feature makes: what breaks without it, what it costs, and
 * which behaviour it is *not* responsible for.
 *
 * The flag only governs **auto-pooling** — grouping externals by npm scope. A declared `pool` tag forms a
 * family with the flag off, and the gates then apply to it exactly the same; that boundary is the second
 * block below, and it is why other files may legitimately run with `pooling: false`.
 */

/**
 * The #63 shape, as small as it gets. `mfe2`'s strict `~22.0.5` pin drags the shared `@angular/core`
 * down to its own build, while `@angular/router` — which `mfe2` does not ship — resolves freely to
 * `mfe1`'s 22.1.0. Nothing else about the two remotes differs.
 */
const splitFamily = () => [
  remote('team/mfe1', SCOPE.mfe1, [
    dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
    dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
  ]),
  remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]),
];

test.describe('the flag: what switching it on changes', () => {
  test('off, one remote runs a family split across two minor lines; on, neither does', async ({
    nf,
  }) => {
    // The `before` arm: nothing coordinates the family, so mfe1 dedups core@22.0.5 from mfe2 while
    // serving router@22.1.0 from itself — two minor lines inside one package family, in one remote.
    await nf.init(splitFamily(), { pooling: false, namespace: 'unpooled' });

    const unpooled = await nf.map();
    expect(unpooled.imports['@angular/core']).toBe('http://mfe2/@angular/core.js');
    expect(unpooled.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
    expect(unpooled.scopes).toBeUndefined();
    expect(await nf.islands()).toEqual([]);
    expect((await nf.loadAll())['team/mfe1']!.seen).toEqual({
      '@angular/core': 'mfe2|@angular/core@22.0.5',
      '@angular/router': 'mfe1|@angular/router@22.1.0',
    });

    // The `after` arm, same input: mfe1 gives up both dedups and serves its own family, so router loses
    // its global entry and every remote holds one line.
    await nf.init(splitFamily(), { namespace: 'pooled' });

    const pooled = await nf.map();
    expect(pooled.imports['@angular/core']).toBe('http://mfe2/@angular/core.js');
    expect(pooled.imports['@angular/router']).toBeUndefined();
    expect(pooled.scopes?.[SCOPE.mfe1]).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
      '@angular/router': 'http://mfe1/@angular/router.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe1 self-serves, no build covers @angular/router']);
    expect((await nf.loadAll())['team/mfe1']!.seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.1.0',
      '@angular/router': 'mfe1|@angular/router@22.1.0',
    });
  });

  test('buys the coherence for one extra download', async ({ nf }) => {
    // The central trade, measured on the smallest possible portfolio: pooling never reduces downloads,
    // it removes the incoherence. Unpooled the two members come from two builds for 2 downloads; pooled
    // mfe1 self-serves both for 3.
    await nf.init(splitFamily(), { pooling: false, namespace: 'unpooled' });
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(2);

    await nf.init(splitFamily(), { namespace: 'pooled' });
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(3);
  });

  test('costs nothing at all on the production capture', async ({ nf }) => {
    // The extra download above is the worst case, not the normal one. On the recorded portfolio the
    // islanded remote swaps deduped copies for its own, one for one: what pooling changed there is which
    // files sit next to each other, not how many. `capture.e2e.spec.ts` says what that portfolio is.
    await nf.init(CAPTURED_SEVEN.map(fixture), { namespace: 'pooled' });
    await nf.loadAll();
    const pooled = nf.downloads().length;

    await nf.init(CAPTURED_SEVEN.map(fixture), { pooling: false, namespace: 'unpooled' });
    await nf.loadAll();

    expect(nf.downloads()).toHaveLength(pooled);
  });

  test('off, an incompatible remote bridges a matching sibling into its own runtime', async ({
    nf,
  }) => {
    // A different failure from the same cause. mfe2 is a major behind on `@acme/framework`, so the
    // resolver scopes that member for it — but `@acme/ui` matches version-for-version at 1.0.0, so mfe2
    // is granted *that* dedup and ends up running a ui built against framework 18 on framework 17. Both
    // members share the `@acme` npm scope, so the flag alone decides whether they are one family.
    const portfolio = () => [
      remote('team/mfe1', SCOPE.mfe1, [dep('@acme/framework', '18.0.0'), dep('@acme/ui', '1.0.0')]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@acme/framework', '17.0.0'), dep('@acme/ui', '1.0.0')]),
    ];

    await nf.init(portfolio(), { pooling: false, namespace: 'unpooled' });

    const unpooled = await nf.map();
    expect(unpooled.scopes?.[SCOPE.mfe2]).toEqual({
      '@acme/framework': 'http://mfe2/@acme/framework.js',
    });
    expect(unpooled.imports['@acme/ui']).toBe('http://mfe1/@acme/ui.js');
    expect((await nf.loadAll())['team/mfe2']!.seen).toEqual({
      '@acme/framework': 'mfe2|@acme/framework@17.0.0',
      '@acme/ui': 'mfe1|@acme/ui@1.0.0',
    });
    expect(await nf.buildsOf('@acme/ui')).toEqual(['mfe1|@acme/ui@1.0.0']);

    // On, the dedup is refused: two uis on the page, each against the framework it was built for. That
    // second copy is the price, and it is what the whole file is arguing about.
    await nf.init(portfolio(), { namespace: 'pooled' });

    expect((await nf.map()).scopes?.[SCOPE.mfe2]).toEqual({
      '@acme/framework': 'http://mfe2/@acme/framework.js',
      '@acme/ui': 'http://mfe2/@acme/ui.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe2 on @acme/framework@17.0.0']);
    await nf.loadAll();
    expect(await nf.buildsOf('@acme/ui')).toEqual(['mfe1|@acme/ui@1.0.0', 'mfe2|@acme/ui@1.0.0']);
  });

  test('off, the shared set itself carries two majors at once', async ({ nf }) => {
    // Islanding governs whose copies get deduped; it says nothing about who serves a member nobody else
    // ships. Unpooled, the cross-major remote's sole-provided members therefore stay globally shared at
    // 21.2.18 beside a shared core@22.0.8 — and any consumer binding the global entry gets the mix.
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

    await nf.init(portfolio(), { pooling: false, namespace: 'unpooled' });

    const unpooled = await nf.map();
    expect(unpooled.imports['@angular/animations']).toBe('http://mfe3/@angular/animations.js');
    expect(unpooled.imports['@angular/compiler']).toBe('http://mfe3/@angular/compiler.js');
    const unpooledMajors = new Set(
      Object.values(sharedTags(await nf.store('unpooled')))
        .flat()
        .map(tag => tag.split('.')[0])
    );
    expect(unpooledMajors).toEqual(new Set(['21', '22']));

    // The crash, reachable from a modern remote's own origin: Angular 21 animations against an
    // Angular 22 core.
    expect(await nf.resolve('@angular/animations', SCOPE.mfe1)).toBe(
      'mfe3|@angular/animations@21.2.18'
    );
    expect(await nf.resolve('@angular/core', SCOPE.mfe1)).toBe('mfe1|@angular/core@22.0.8');

    // On, the islanded remote contributes no build at all — not even for the members it solely provides,
    // so they leave the shared set with it and nothing outside the island can reach the 21 build.
    await nf.init(portfolio(), { namespace: 'pooled' });

    const pooled = await nf.map();
    expect(pooled.imports['@angular/animations']).toBeUndefined();
    expect(pooled.scopes?.[SCOPE.mfe3]).toEqual({
      '@angular/core': 'http://mfe3/@angular/core.js',
      '@angular/common': 'http://mfe3/@angular/common.js',
      '@angular/animations': 'http://mfe3/@angular/animations.js',
      '@angular/compiler': 'http://mfe3/@angular/compiler.js',
    });
    const pooledMajors = new Set(
      Object.values(sharedTags(await nf.store('pooled')))
        .flat()
        .map(tag => tag.split('.')[0])
    );
    expect(pooledMajors).toEqual(new Set(['22']));
    expect(await nf.resolve('@angular/animations', SCOPE.mfe1)).toContain('UNRESOLVED');
  });

  test('off, a remote loaded at runtime is free to mix builds too', async ({ nf }) => {
    // The flag reaches the dynamic path as well. mfe2 arrives after the map is committed; unpooled it
    // dedups the committed router@22.1.0 and publishes its own forms@22.0.5 globally, so from then on
    // every remote in the app can import a family split across a minor line.
    const anchor = () =>
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]);
    const late = () =>
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/router', '22.0.5', { req: '^22.0.0' }),
        dep('@angular/forms', '22.0.5', { req: '^22.0.0' }),
      ]);

    await nf.init([anchor()], { pooling: false, unlisted: [late()], namespace: 'unpooled' });
    await nf.initRemoteEntry(late().url);

    const unpooled = await nf.map();
    expect(unpooled.scopes).toBeUndefined();
    expect(unpooled.imports['@angular/forms']).toBe('http://mfe2/@angular/forms.js');
    expect((await nf.load('team/mfe2')).seen).toEqual({
      '@angular/router': 'mfe1|@angular/router@22.1.0',
      '@angular/forms': 'mfe2|@angular/forms@22.0.5',
    });

    // On, the gate is mirrored onto the newly loaded remote: it serves its whole family itself and its
    // sole-provided forms is not published globally off a build that disagrees with the committed one.
    await nf.init([anchor()], { unlisted: [late()], namespace: 'pooled' });
    await nf.initRemoteEntry(late().url);

    const pooled = await nf.map();
    expect(pooled.scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/router': 'http://mfe2/@angular/router.js',
      '@angular/forms': 'http://mfe2/@angular/forms.js',
    });
    expect(pooled.imports['@angular/forms']).toBeUndefined();
    expect((await nf.load('team/mfe2')).seen).toEqual({
      '@angular/router': 'mfe2|@angular/router@22.0.5',
      '@angular/forms': 'mfe2|@angular/forms@22.0.5',
    });
  });
});

test.describe('the flag: what it does not change', () => {
  test('still coordinates a family that carries an explicit `pool` tag', async ({ nf }) => {
    // Auto-pooling off is not "pooling off": one declared tag is enough to form the family, and the same
    // gate then applies to it. This is the boundary that lets the other specs use `pooling: false` to
    // isolate the tag mechanism.
    const ng = (pkg: string, version: string, req: string) =>
      dep(pkg, version, { req, pool: 'ng' });

    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [
          ng('@angular/core', '22.1.0', '^22.0.0'),
          ng('@angular/router', '22.1.0', '^22.0.0'),
        ]),
        remote('team/mfe2', SCOPE.mfe2, [ng('@angular/core', '22.0.5', '~22.0.5')]),
      ],
      { pooling: false }
    );

    expect((await nf.map()).scopes?.[SCOPE.mfe1]).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
      '@angular/router': 'http://mfe1/@angular/router.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe1 self-serves, no build covers @angular/router']);
  });

  test('decides entrypoint coverage the same way either way', async ({ nf }) => {
    // Entrypoint coverage — which build serves a package whose remotes declare different subsets of its
    // entrypoints — is a *resolver* policy, decided per external in `determine` and
    // `generate-import-map`. The portfolio below holds a single external, so its pool has one member and
    // the gates have nothing to coordinate: both flag settings must produce the identical map, including
    // the self-fill case, the one a pool gate could plausibly reach.
    // See `entrypoints.e2e.spec.ts` for what the policy itself does.
    const M = '@angular/material';
    const portfolio = () => [
      remote('team/mfe1', SCOPE.mfe1, [
        dep(M, '22.0.6', { req: '~22.0.6', entrypoints: ['/table', '/sort'] }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep(M, '22.0.6', { req: '~22.0.6', entrypoints: ['/table', '/paginator'] }),
      ]),
    ];

    await nf.init(portfolio(), { namespace: 'pooled' });
    const pooled = await nf.map();

    await nf.init(portfolio(), { pooling: false, namespace: 'unpooled' });

    expect(await nf.map()).toEqual(pooled);
  });

  test('leaves a hand-tagged portfolio with the gaps auto-pooling closes', async ({ nf }) => {
    // The argument for auto-pooling, on the production capture. Three of the seven remotes tag their
    // Angular packages `pool: ng-core`; the cross-major remote tags nothing. With auto-pooling off the
    // family is therefore whatever those tags happen to cover.
    //
    // REWRITTEN for the per-remote auto-pool rule. This used to assert that partial tagging left
    // `@angular/forms` and `@angular/platform-browser` each published at *two* tags. It no longer does,
    // and the reason is the entrypoint rule: the tagging remotes tag every Angular external they
    // declare, flat secondary entrypoints included, and an entrypoint now carries its package into
    // whatever pool it joined. `@angular/forms/signals` therefore pulls `@angular/forms` in even though
    // nobody tagged the package itself. A single package split across two tags is exactly the tear that
    // rule exists to prevent, so closing it here is the rule working, not the argument weakening.
    //
    // What partial tagging still leaves is the gap below: the shared set straddles two majors, with
    // four members published on the previous line beside the rest on the current one. Any consumer that
    // binds a 21 member against a 22 one gets a mixed runtime, which is what auto-pooling closes.
    await nf.init(CAPTURED_SEVEN.map(fixture), { pooling: false, namespace: 'partial' });

    expect(await splitPackages(nf, 'partial')).toEqual({});

    const partialTags = await angularTags(nf, 'partial');
    expect(new Set(Object.values(partialTags).map(tag => tag.split('.')[0]))).toEqual(
      new Set(['21', '22'])
    );
    expect(Object.keys(partialTags).filter(name => partialTags[name]!.startsWith('21.'))).toEqual([
      '@angular/animations',
      '@angular/animations/browser',
      '@angular/compiler',
      '@angular/platform-browser-dynamic',
    ]);

    // Where the damage is, precisely. On *this* portfolio every remote still resolves consistently: both
    // shared tags exist, but each remote declared the family itself, so each gets the tag its own range
    // elected — the 21 half is reachable only from the cross-major remote's scope.
    const loaded = await nf.loadAll();
    for (const lines of Object.values(angularLinesPerRemote(loaded))) expect(lines).toHaveLength(1);
    for (const specifier of ['@angular/core', '@angular/forms', '@angular/platform-browser'])
      expect(await nf.resolve(specifier, SCOPE.host)).toContain('@22.0.8');

    // So the defect this portfolio exhibits is in the shared *set*, not yet in the running page: two
    // lines are published as shareable at once, and the next consumer to bind against the global entry
    // for one of them — host code, or a remote that does not declare the whole family — gets the mix.
    // The reachable version of that crash is the fourth test in the block above.
    //
    // With auto-pooling on, the same portfolio publishes one major: the four 21-line members leave the
    // shared set with the islanded remote that solely provided them, rather than staying shareable
    // beside a 22 family.
    await nf.init(CAPTURED_SEVEN.map(fixture), { namespace: 'auto' });

    expect(await splitPackages(nf, 'auto')).toEqual({});
    const autoTags = await angularTags(nf, 'auto');
    expect(new Set(Object.values(autoTags).map(tag => tag.split('.')[0]))).toEqual(new Set(['22']));
    expect(Object.keys(autoTags)).not.toContain('@angular/compiler');
  });
});
