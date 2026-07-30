import { test, expect, sharedTags } from '../harness/federation';
import { dep, remote, SCOPE, HOST_NAME } from '../harness/portfolio';

/**
 * What an island *is*: the shape of the verdict, once a gate has fired.
 *
 * A remote holding a version `determine` marked `scope` serves its whole family from its own build,
 * with NO dedup: a sibling that happens to match version-for-version would otherwise bridge a foreign
 * framework runtime into it. All-or-nothing is load-bearing, not merely tidy — letting an incompatible
 * remote self-serve only the members it rejects was measured to remove the coherence guarantee outright,
 * because a fully cross-major remote then draws on nothing but itself and passes every later check
 * vacuously while its sole-provided members stay shared to the modern side.
 */
test.describe('islands: all or nothing', () => {
  const tagged = (pkg: string, version: string, req: string) =>
    dep(pkg, version, { req, pool: 'framework' });

  test('refuses to dedup a matching sibling into an incompatible remote', async ({ nf }) => {
    // mfe-b lags a major behind on the framework. @design-system/ui matches exactly at 1.0.0, so the
    // resolver granted mfe-b that dedup — but taking it would load the shared ui built against
    // framework 18 inside a remote running framework 17. The whole family is scoped for mfe-b instead.
    //
    // Membership here is by declared `pool` tag, with auto-pooling off: a design system opting into
    // being coupled to the framework it is built against.
    await nf.init(
      [
        remote('team/mfe-a', SCOPE.a, [
          tagged('@framework/core', '18.0.0', '^18.0.0'),
          tagged('@design-system/ui', '1.0.0', '^1.0.0'),
        ]),
        remote('team/mfe-b', SCOPE.b, [
          tagged('@framework/core', '17.0.0', '^17.0.0'),
          tagged('@design-system/ui', '1.0.0', '^1.0.0'),
        ]),
      ],
      { pooling: false }
    );

    const map = await nf.map();
    expect(map.imports['@framework/core']).toBe('http://mfe-a/@framework/core.js');
    expect(map.imports['@design-system/ui']).toBe('http://mfe-a/@design-system/ui.js');
    expect(map.scopes?.[SCOPE.b]).toEqual({
      '@framework/core': 'http://mfe-b/@framework/core.js',
      '@design-system/ui': 'http://mfe-b/@design-system/ui.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe-b on @framework/core@17.0.0']);

    // The whole point, measured: the page runs two design systems, each against the framework it was
    // built for. Two copies is the cost of coherence here, not a leak.
    await nf.loadAll();
    expect(await nf.buildsOf('@design-system/ui')).toEqual([
      'mfe-a|@design-system/ui@1.0.0',
      'mfe-b|@design-system/ui@1.0.0',
    ]);
  });

  test('bridges the same sibling in when pooling is off', async ({ nf }) => {
    // The contrast that shows what the gate buys: unpooled, mfe-b scopes only the member it rejects
    // and dedups @design-system/ui — one download cheaper, and a foreign framework runtime inside it.
    await nf.init(
      [
        remote('team/mfe-a', SCOPE.a, [
          dep('@framework/core', '18.0.0'),
          dep('@design-system/ui', '1.0.0'),
        ]),
        remote('team/mfe-b', SCOPE.b, [
          dep('@framework/core', '17.0.0'),
          dep('@design-system/ui', '1.0.0'),
        ]),
      ],
      { pooling: false }
    );

    const map = await nf.map();
    expect(map.scopes?.[SCOPE.b]).toEqual({ '@framework/core': 'http://mfe-b/@framework/core.js' });
    expect(map.imports['@design-system/ui']).toBe('http://mfe-a/@design-system/ui.js');
    expect(await nf.islands()).toEqual([]);

    // The mismatch, observed: mfe-b's code holds framework 17 and a ui built against 18.
    expect((await nf.loadAll())['team/mfe-b']!.seen).toEqual({
      '@framework/core': 'mfe-b|@framework/core@17.0.0',
      '@design-system/ui': 'mfe-a|@design-system/ui@1.0.0',
    });
    expect(await nf.buildsOf('@design-system/ui')).toEqual(['mfe-a|@design-system/ui@1.0.0']);
  });

  test('islands every incompatible remote independently', async ({ nf }) => {
    // Three majors in one family: the 22 majority anchors, and the two laggards each self-serve their
    // own whole family. Islands are per remote — one remote's island never drags a compatible one in.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.0.8', { req: '^22.0.0' }),
        dep('@angular/router', '22.0.8', { req: '^22.0.0' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [
        dep('@angular/core', '22.0.8', { req: '^22.0.0' }),
        dep('@angular/router', '22.0.8', { req: '^22.0.0' }),
      ]),
      remote('team/legacy-a', SCOPE.legacyA, [
        dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        dep('@angular/router', '21.2.18', { req: '~21.2.0' }),
      ]),
      remote('team/legacy-b', SCOPE.legacyB, [
        dep('@angular/core', '20.1.0', { req: '~20.1.0' }),
        dep('@angular/router', '20.1.0', { req: '~20.1.0' }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe-a/@angular/router.js');

    // mfe-b dedups both members, so it gets no scope of its own.
    expect(map.scopes?.[SCOPE.b]).toBeUndefined();
    expect(await nf.islands()).toEqual([
      'team/legacy-a on @angular/core@21.2.18',
      'team/legacy-b on @angular/core@20.1.0',
    ]);

    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(6);
    expect(await nf.buildsOf('@angular/core')).toEqual([
      'mfe-a|@angular/core@22.0.8',
      'legacy-a|@angular/core@21.2.18',
      'legacy-b|@angular/core@20.1.0',
    ]);
  });
});

/**
 * The failure mode neither split-family reproduction shows: the *shared set itself* is incoherent, not
 * just one remote's view of it.
 *
 * The legacy remote is correctly islanded on the members it conflicts on, but it is also the sole
 * provider of others. Islanding governs whose copies get deduped; it says nothing about who serves a
 * member nobody else ships — so before the fix `@angular/animations@21.2.18` stayed globally shared
 * beside `@angular/core@22.0.8`, and any remote consuming both loaded Angular 21 animations against an
 * Angular 22 core. The rule that repairs it: an islanded remote contributes NO build at all, not even
 * for members it solely provides.
 */
test.describe('islands: the shared set stays coherent', () => {
  const capture = () => [
    remote('team/mfe-x', SCOPE.x, [
      dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
      dep('@angular/common', '22.0.8', { req: '~22.0.3' }),
    ]),
    remote('team/mfe-y', SCOPE.y, [
      dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
      dep('@angular/common', '22.0.8', { req: '~22.0.3' }),
    ]),
    remote('team/legacy', SCOPE.legacy, [
      dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
      dep('@angular/common', '21.2.18', { req: '~21.2.0' }),
      dep('@angular/animations', '21.2.18', { req: '~21.2.0' }),
      dep('@angular/compiler', '21.2.18', { req: '~21.2.0' }),
    ]),
  ];

  test('drops the sole-provided members of an islanded remote from the shared set', async ({
    nf,
  }) => {
    await nf.init(capture());

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-x/@angular/core.js');
    expect(map.imports['@angular/common']).toBe('http://mfe-x/@angular/common.js');

    // The members only the islanded remote ships are NOT published globally at 21.2.18 next to a
    // shared core@22.0.8 — they go with the island.
    expect(map.imports['@angular/animations']).toBeUndefined();
    expect(map.imports['@angular/compiler']).toBeUndefined();
    expect(map.scopes?.[SCOPE.legacy]).toEqual({
      '@angular/core': 'http://legacy/@angular/core.js',
      '@angular/common': 'http://legacy/@angular/common.js',
      '@angular/animations': 'http://legacy/@angular/animations.js',
      '@angular/compiler': 'http://legacy/@angular/compiler.js',
    });

    // And nothing outside the island can reach the 21 build at all — the strongest form of the claim.
    expect(await nf.resolve('@angular/animations', SCOPE.x)).toContain('UNRESOLVED');
    expect(await nf.resolve('@angular/animations', SCOPE.legacy)).toBe(
      'legacy|@angular/animations@21.2.18'
    );
  });

  test('leaves exactly one major in the shared set, no package split across two tags', async ({
    nf,
  }) => {
    await nf.init(capture());

    // The coherence measure, read off the committed store: every shared tag on one major, and no
    // member shared at two tags at once.
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

  test('leaves the incoherent shared set in place when pooling is off', async ({ nf }) => {
    // The same portfolio unpooled: animations and compiler stay globally shared at 21.2.18 beside
    // core@22.0.8 — cheaper by two downloads, and exactly the cross-major split that crashes.
    await nf.init(capture(), { pooling: false });

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-x/@angular/core.js');
    expect(map.imports['@angular/animations']).toBe('http://legacy/@angular/animations.js');
    expect(map.imports['@angular/compiler']).toBe('http://legacy/@angular/compiler.js');

    const majors = new Set(
      Object.values(sharedTags(await nf.store()))
        .flat()
        .map(tag => tag.split('.')[0])
    );
    expect(majors).toEqual(new Set(['21', '22']));

    // Any remote that consumes both now really does get Angular 21 animations against an Angular 22
    // core — the crash, reachable from mfe-x's own origin.
    expect(await nf.resolve('@angular/animations', SCOPE.x)).toBe(
      'legacy|@angular/animations@21.2.18'
    );
    expect(await nf.resolve('@angular/core', SCOPE.x)).toBe('mfe-x|@angular/core@22.0.8');
  });

  test('cascades: an island that removes a member’s last provider can island its consumers', async ({
    nf,
  }) => {
    // Islanding is monotone, so the gate iterates to a fixed point.
    //
    // mfe-x is islanded on core by strict incompatibility (gate 1), and it was the elected provider of
    // forms@22.0.8. With its copies gone, forms has no serving build, so mfe-y must self-serve
    // forms@22.1.0 while deduping core@22.0.8 from mfe-z — builds that disagree across a minor line,
    // which islands mfe-y in turn (gate 2).
    await nf.init([
      remote('team/mfe-z', SCOPE.z, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/mfe-y', SCOPE.y, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/forms', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe-x', SCOPE.x, [
        dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        dep('@angular/forms', '22.0.8', { req: '~22.0.3' }),
      ]),
    ]);

    expect(await nf.islands()).toEqual([
      'team/mfe-x on @angular/core@21.2.18',
      'team/mfe-y mixes @angular/core 22.0.8 vs 22.1.0',
    ]);

    // core keeps its provider; forms ends up shared by nobody, and both islanded remotes self-serve.
    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-z/@angular/core.js');
    expect(map.imports['@angular/forms']).toBeUndefined();
    expect(map.scopes).toEqual({
      [SCOPE.y]: {
        '@angular/core': 'http://mfe-y/@angular/core.js',
        '@angular/forms': 'http://mfe-y/@angular/forms.js',
      },
      [SCOPE.x]: {
        '@angular/core': 'http://mfe-x/@angular/core.js',
        '@angular/forms': 'http://mfe-x/@angular/forms.js',
      },
    });

    // Three builds of core live on the page, and every remote's forms matches its own core.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe-y']!.seen).toEqual({
      '@angular/core': 'mfe-y|@angular/core@22.1.0',
      '@angular/forms': 'mfe-y|@angular/forms@22.1.0',
    });
    expect(loaded['team/mfe-x']!.seen).toEqual({
      '@angular/core': 'mfe-x|@angular/core@21.2.18',
      '@angular/forms': 'mfe-x|@angular/forms@22.0.8',
    });
  });
});

/**
 * The host `remoteEntry` is a remote entry like any other, except that its versions win outright.
 *
 * The host case was for a while considered unfixable — repairing it seemed to require overriding the
 * host's pin, and locking a version through the host remoteEntry is a deliberate act that outranks
 * pooling. The gate resolves it the other way round: the host keeps its pin and the remote that would
 * mix builds gives way.
 */
test.describe('islands: host precedence', () => {
  const hostPin = (tag: string) =>
    remote(HOST_NAME, SCOPE.host, [dep('@angular/core', tag, { req: '^22.0.0' })]);

  test('keeps the host tag and islands the remote that would mix builds', async ({ nf }) => {
    // The host ships core@22.0.5 and no router, so host precedence pins the shared core to the host's
    // tag while router resolves freely from mfe-a. Coherence and absolute host priority are not in
    // tension: it is mfe-a that gives way, never the host's pin.
    await nf.init(
      [
        remote('team/mfe-a', SCOPE.a, [
          dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
          dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
        ]),
      ],
      { hostEntry: hostPin('22.0.5') }
    );

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://host.service/@angular/core.js');
    expect(map.imports['@angular/router']).toBeUndefined();
    expect(map.scopes?.[SCOPE.a]).toEqual({
      '@angular/core': 'http://mfe-a/@angular/core.js',
      '@angular/router': 'http://mfe-a/@angular/router.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe-a mixes @angular/core 22.0.5 vs 22.1.0']);

    // The host's own page code gets the host build; mfe-a's code gets mfe-a's, consistently.
    expect(await nf.resolve('@angular/core', SCOPE.host)).toBe('host.service|@angular/core@22.0.5');
    expect((await nf.loadAll())['team/mfe-a']!.seen).toEqual({
      '@angular/core': 'mfe-a|@angular/core@22.1.0',
      '@angular/router': 'mfe-a|@angular/router@22.1.0',
    });
  });

  test('keeps the host tag even when the host is the minority', async ({ nf }) => {
    // Two remotes on 22.1.0 against one host on 22.0.5: the resolver would prefer the tag with the
    // fewest extra copies, but host precedence short-circuits the objective entirely. Both remotes
    // island; the host is never re-pointed.
    await nf.init(
      [
        remote('team/mfe-a', SCOPE.a, [
          dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
          dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
        ]),
        remote('team/mfe-b', SCOPE.b, [
          dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
          dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
        ]),
      ],
      { hostEntry: hostPin('22.0.5') }
    );

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://host.service/@angular/core.js');
    expect(map.scopes?.[SCOPE.a]).toEqual({
      '@angular/core': 'http://mfe-a/@angular/core.js',
      '@angular/router': 'http://mfe-a/@angular/router.js',
    });
    expect(map.scopes?.[SCOPE.b]).toEqual({
      '@angular/core': 'http://mfe-b/@angular/core.js',
      '@angular/router': 'http://mfe-b/@angular/router.js',
    });
  });
});

test.describe('islands: the feature flag boundary', () => {
  const splitFamily = () => [
    remote('team/mfe-a', SCOPE.a, [
      dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
      dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
    ]),
    remote('team/mfe-b', SCOPE.b, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]),
  ];

  test('reproduces the defect with pooling switched off', async ({ nf }) => {
    // The `before` arm, and the boundary of the feature flag: nothing coordinates the family, so
    // mfe-a dedups core@22.0.5 from mfe-b while serving router@22.1.0 from itself — the crash.
    await nf.init(splitFamily(), { pooling: false });

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-b/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe-a/@angular/router.js');
    expect(map.scopes).toBeUndefined();
    expect(await nf.islands()).toEqual([]);

    // The split family, in the running page: mfe-a's code holds core 22.0.5 and router 22.1.0.
    expect((await nf.loadAll())['team/mfe-a']!.seen).toEqual({
      '@angular/core': 'mfe-b|@angular/core@22.0.5',
      '@angular/router': 'mfe-a|@angular/router@22.1.0',
    });
  });

  test('buys the coherence for one extra download', async ({ nf }) => {
    // The central trade, measured on the smallest possible portfolio: pooling never reduces downloads,
    // it removes the incoherence. Unpooled the two members come from two builds for 2 downloads; pooled
    // mfe-a self-serves both for 3.
    await nf.init(splitFamily(), { pooling: false, namespace: 'unpooled' });
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(2);

    await nf.init(splitFamily(), { namespace: 'pooled' });
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(3);
  });

  test('still coordinates a family that carries an explicit `pool` tag', async ({ nf }) => {
    // Auto-pooling off is not "pooling off": one declared tag is enough to form the family, and the
    // same gate then applies to it.
    const ng = (pkg: string, version: string, req: string) =>
      dep(pkg, version, { req, pool: 'ng' });

    await nf.init(
      [
        remote('team/mfe-a', SCOPE.a, [
          ng('@angular/core', '22.1.0', '^22.0.0'),
          ng('@angular/router', '22.1.0', '^22.0.0'),
        ]),
        remote('team/mfe-b', SCOPE.b, [ng('@angular/core', '22.0.5', '~22.0.5')]),
      ],
      { pooling: false }
    );

    expect((await nf.map()).scopes?.[SCOPE.a]).toEqual({
      '@angular/core': 'http://mfe-a/@angular/core.js',
      '@angular/router': 'http://mfe-a/@angular/router.js',
    });
  });
});
