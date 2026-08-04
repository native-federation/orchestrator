import { test, expect } from '../harness/federation';
import { dep, remote, SCOPE, HOST_NAME } from '../harness/portfolio';

/**
 * **Symmetric pool families**: every remote in the pool declares the *same members*, so the only thing
 * that can differ is the version line each one is on. Who serves which member is never in question —
 * one build can always cover the whole family for everybody — which isolates the version fields
 * (`version`, `requiredVersion`, `strictVersion`) and the election that reads them.
 *
 * That makes the coverage rule cheap here by construction: when every remote declares the same members,
 * whichever build wins covers all of them, so nobody has to serve its own family and patch drift
 * disappears into the election rather than being tolerated beside it — the losing tag is simply never
 * downloaded. (Under the minor-line agreement gate this replaced, `21.2.2` and `21.2.3` were instead held
 * to agree and a remote could genuinely run one member from each build; `asymmetric.e2e.spec.ts` is where
 * that showed, because there no single build covers everybody.)
 *
 * One thing does still split a symmetric family: the host, whose tag wins outright whether or not any
 * remote's build shipped it beside the rest of the family — see the host-precedence block below.
 *
 * Asymmetric member sets — subsets, sole providers, disjoint builds — are `asymmetric.e2e.spec.ts`.
 */
test.describe('symmetric: one minor line, or two', () => {
  test('costs one copy of each member for the whole portfolio', async ({ nf }) => {
    // The baseline every other case is a deviation from: two remotes, identical declarations.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
        dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
      ]),
    ]);

    // Nothing is scoped at all, so the map carries no `scopes` key.
    expect((await nf.map()).scopes).toBeUndefined();
    await nf.loadAll();
    expect(nf.downloads()).toEqual([
      'http://mfe1/@angular/core.js',
      'http://mfe1/@angular/router.js',
    ]);
    expect(await nf.buildsOf('@angular/core')).toEqual(['mfe1|@angular/core@22.1.0']);
  });

  test('absorbs patch drift into one build when the member sets match', async ({ nf }) => {
    // Both remotes declare `~21.2.0` and sit one patch apart. Because they ship the same two members,
    // one build covers both remotes and the drift disappears into the election — the losing patch tag is
    // simply never downloaded.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '21.2.3', { req: '~21.2.0' }),
        dep('@angular/router', '21.2.3', { req: '~21.2.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '21.2.2', { req: '~21.2.0' }),
        dep('@angular/router', '21.2.2', { req: '~21.2.0' }),
      ]),
    ]);

    expect((await nf.map()).scopes).toBeUndefined();
    expect(await nf.islands()).toEqual([]);
    expect(await nf.warns()).toEqual([]);

    const loaded = await nf.loadAll();
    expect(loaded['team/mfe2']!.seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@21.2.3',
      '@angular/router': 'mfe1|@angular/router@21.2.3',
    });
    expect(nf.downloads()).toHaveLength(2);
  });

  test('dedups a pin that actually fits', async ({ nf }) => {
    // Not every pin splits a family. `~22.0.5` accepts every 22.0.x from 22.0.5 up, so the other
    // remote's 22.0.8 satisfies it: the pinning remote dedups and nothing is scoped. Reproducing a split
    // needs a *minor* gap, which the next case uses.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
        dep('@angular/router', '22.0.8', { req: '~22.0.3' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.0.8', { req: '~22.0.5' }),
        dep('@angular/router', '22.0.8', { req: '~22.0.5' }),
      ]),
    ]);

    expect((await nf.map()).scopes).toBeUndefined();
    expect(await nf.islands()).toEqual([]);
  });

  test('islands on mutually exclusive pins, with no major gap anywhere', async ({ nf }) => {
    // Incompatibility is not the same thing as a major gap. mfe2 pins each member exactly at 22.0.5 and
    // mfe1's `~22.1.0` cannot reach down to it, so neither range accepts the other's tag: the election is
    // a tie on copies, the newest tag takes it, and mfe2 is islanded on a patch-level conflict inside one
    // major.
    //
    // Note which pin loses. An exact pin only wins the election when the *others* can accept it — with
    // `^22.0.0` on mfe1 it would have dragged the shared core down to 22.0.5 instead.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '~22.1.0' }),
        dep('@angular/router', '22.1.0', { req: '~22.1.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.0.5', { req: '22.0.5' }),
        dep('@angular/router', '22.0.5', { req: '22.0.5' }),
      ]),
    ]);

    expect(await nf.islands()).toEqual(['team/mfe2 on @angular/core@22.0.5']);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
      '@angular/router': 'http://mfe2/@angular/router.js',
    });
    expect((await nf.loadAll())['team/mfe2']!.seen).toEqual({
      '@angular/core': 'mfe2|@angular/core@22.0.5',
      '@angular/router': 'mfe2|@angular/router@22.0.5',
    });
  });

  test('islands across a major gap, whole family', async ({ nf }) => {
    // The oldest case: the range violation is real, so the incompatible remote gets no dedup at all —
    // not even of `@angular/router`, which matches version-for-version at its own major.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '18.0.0'),
        dep('@angular/router', '18.0.0'),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '17.0.0'),
        dep('@angular/router', '17.0.0'),
      ]),
    ]);

    expect(await nf.islands()).toEqual(['team/mfe2 on @angular/core@17.0.0']);
    expect((await nf.map()).scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe2/@angular/core.js',
      '@angular/router': 'http://mfe2/@angular/router.js',
    });
  });
});

/**
 * All-or-nothing is load-bearing, not merely tidy. Letting an incompatible remote self-serve only the
 * members it rejects was measured to remove the coherence guarantee outright: a fully cross-major remote
 * then draws on nothing but itself and passes every later check vacuously, while its sole-provided
 * members stay shared to the modern side.
 */
test.describe('symmetric: an island takes the whole family', () => {
  test('refuses to dedup a matching sibling into an incompatible remote', async ({ nf }) => {
    // mfe2 lags a major behind on the framework. `@design-system/ui` matches exactly at 1.0.0, so the
    // resolver granted mfe2 that dedup — but taking it would load the shared ui built against framework
    // 18 inside a remote running framework 17. The whole family is scoped for mfe2 instead.
    //
    // Membership here is by declared `pool` tag, with auto-pooling off: a design system opting into being
    // coupled to the framework it is built against. The tag mechanism is `membership.e2e.spec.ts`; that
    // the flag does not change this verdict is `flag.e2e.spec.ts`.
    const tagged = (pkg: string, version: string, req: string) =>
      dep(pkg, version, { req, pool: 'framework' });

    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [
          tagged('@framework/core', '18.0.0', '^18.0.0'),
          tagged('@design-system/ui', '1.0.0', '^1.0.0'),
        ]),
        remote('team/mfe2', SCOPE.mfe2, [
          tagged('@framework/core', '17.0.0', '^17.0.0'),
          tagged('@design-system/ui', '1.0.0', '^1.0.0'),
        ]),
      ],
      { pooling: false }
    );

    const map = await nf.map();
    expect(map.imports['@framework/core']).toBe('http://mfe1/@framework/core.js');
    expect(map.imports['@design-system/ui']).toBe('http://mfe1/@design-system/ui.js');
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      '@framework/core': 'http://mfe2/@framework/core.js',
      '@design-system/ui': 'http://mfe2/@design-system/ui.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe2 on @framework/core@17.0.0']);

    // The whole point, measured: the page runs two design systems, each against the framework it was
    // built for. Two copies is the cost of coherence here, not a leak.
    await nf.loadAll();
    expect(await nf.buildsOf('@design-system/ui')).toEqual([
      'mfe1|@design-system/ui@1.0.0',
      'mfe2|@design-system/ui@1.0.0',
    ]);
  });

  test('islands every incompatible remote independently', async ({ nf }) => {
    // Three majors in one family: the 22 majority anchors, and the two laggards each self-serve their own
    // whole family. Islands are per remote — one remote's island never drags a compatible one in.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.0.8', { req: '^22.0.0' }),
        dep('@angular/router', '22.0.8', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.0.8', { req: '^22.0.0' }),
        dep('@angular/router', '22.0.8', { req: '^22.0.0' }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        dep('@angular/router', '21.2.18', { req: '~21.2.0' }),
      ]),
      remote('team/mfe4', SCOPE.mfe4, [
        dep('@angular/core', '20.1.0', { req: '~20.1.0' }),
        dep('@angular/router', '20.1.0', { req: '~20.1.0' }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');

    // mfe2 dedups both members, so it gets no scope of its own.
    expect(map.scopes?.[SCOPE.mfe2]).toBeUndefined();
    expect(await nf.islands()).toEqual([
      'team/mfe3 on @angular/core@21.2.18',
      'team/mfe4 on @angular/core@20.1.0',
    ]);

    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(6);
    expect(await nf.buildsOf('@angular/core')).toEqual([
      'mfe1|@angular/core@22.0.8',
      'mfe3|@angular/core@21.2.18',
      'mfe4|@angular/core@20.1.0',
    ]);
  });

  test('splits two against two: the newest line wins and both losers island whole', async ({
    nf,
  }) => {
    // A symmetric portfolio with no majority. Two remotes pin `~22.1.0`, two pin `22.0.5` exactly, and
    // neither range accepts the other's tag — so the objective is a tie at two uncached copies a side and
    // the newest tag decides. Both remotes on the losing line island, with their whole family.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.1.0', { req: '~22.1.0' }),
        dep('@angular/router', '22.1.0', { req: '~22.1.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.1.0', { req: '~22.1.0' }),
        dep('@angular/router', '22.1.0', { req: '~22.1.0' }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep('@angular/core', '22.0.5', { req: '22.0.5' }),
        dep('@angular/router', '22.0.5', { req: '22.0.5' }),
      ]),
      remote('team/mfe4', SCOPE.mfe4, [
        dep('@angular/core', '22.0.5', { req: '22.0.5' }),
        dep('@angular/router', '22.0.5', { req: '22.0.5' }),
      ]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
    expect(await nf.islands()).toEqual([
      'team/mfe3 on @angular/core@22.0.5',
      'team/mfe4 on @angular/core@22.0.5',
    ]);

    // The two losers island *separately* — they are on the same tag, but an island is per remote, so each
    // serves its own copy and the page holds three builds of core for four remotes.
    expect(map.scopes?.[SCOPE.mfe3]).toEqual({
      '@angular/core': 'http://mfe3/@angular/core.js',
      '@angular/router': 'http://mfe3/@angular/router.js',
    });
    expect(map.scopes?.[SCOPE.mfe4]).toEqual({
      '@angular/core': 'http://mfe4/@angular/core.js',
      '@angular/router': 'http://mfe4/@angular/router.js',
    });

    const loaded = await nf.loadAll();
    expect(loaded['team/mfe4']!.seen).toEqual({
      '@angular/core': 'mfe4|@angular/core@22.0.5',
      '@angular/router': 'mfe4|@angular/router@22.0.5',
    });
    expect(await nf.buildsOf('@angular/core')).toHaveLength(3);
  });
});

/**
 * The host `remoteEntry` is a remote entry like any other, except that its versions win outright.
 *
 * The host case was for a while considered unfixable — repairing it seemed to require overriding the
 * host's pin, and locking a version through the host remoteEntry is a deliberate act that outranks
 * pooling. The gate resolves it the other way round: the host keeps its pin and the remote that would mix
 * builds gives way.
 */
test.describe('symmetric: host precedence', () => {
  const hostPin = (tag: string) =>
    remote(HOST_NAME, SCOPE.host, [dep('@angular/core', tag, { req: '^22.0.0' })]);

  test('keeps the host tag and islands the remote that would mix builds', async ({ nf }) => {
    // The host ships core@22.0.5 and no router, so host precedence pins the shared core to the host's tag
    // while router resolves freely from mfe1. Coherence and absolute host priority are not in tension: it
    // is mfe1 that gives way, never the host's pin.
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [
          dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
          dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
        ]),
      ],
      { hostEntry: hostPin('22.0.5') }
    );

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://host.service/@angular/core.js');
    expect(map.imports['@angular/router']).toBeUndefined();
    expect(map.scopes?.[SCOPE.mfe1]).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
      '@angular/router': 'http://mfe1/@angular/router.js',
    });
    expect(await nf.islands()).toEqual(['team/mfe1 self-serves, no build covers @angular/router']);

    // The host's own page code gets the host build; mfe1's code gets mfe1's, consistently.
    expect(await nf.resolve('@angular/core', SCOPE.host)).toBe('host.service|@angular/core@22.0.5');
    expect((await nf.loadAll())['team/mfe1']!.seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.1.0',
      '@angular/router': 'mfe1|@angular/router@22.1.0',
    });
  });

  test('keeps the host tag even when the host is the minority, on one build for both', async ({
    nf,
  }) => {
    // **Rewritten for the provenance promise** (#63), and one of the few places it is *cheaper* than the
    // rule it replaces. Two remotes on 22.1.0 against one host on 22.0.5: host precedence short-circuits
    // the download objective entirely, so core stays on the host's tag and neither remote may take it
    // beside a 22.1.0 router.
    //
    // What the old promise did: island both, each running its own core and router — 4 downloads. What the
    // new one does: mfe1 serves its own family and mfe2, whose ranges accept 22.1.0, *dedups onto mfe1's
    // build* rather than downloading a second copy of the same two files. Multi-anchor assignment is what
    // makes that possible (constraint 3); a single-anchor rule has no build to offer mfe2 but the host's.
    // **Delta: −2 downloads** (4 → 2), and nothing is islanded, so nothing is logged.
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [
          dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
          dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
        ]),
        remote('team/mfe2', SCOPE.mfe2, [
          dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
          dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
        ]),
      ],
      { hostEntry: hostPin('22.0.5') }
    );

    expect(await nf.islands()).toEqual([]);
    expect(await nf.warns()).toEqual([]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://host.service/@angular/core.js');
    // Router's global mapping is already mfe1's file, so neither scope repeats it (Performance §9): the
    // only thing either remote has to be told is where its core comes from.
    expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
    expect(map.scopes?.[SCOPE.mfe1]).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
    });
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
    });

    // Both remotes run mfe1's build, the host keeps its own, and the page holds two Angular copies.
    const loaded = await nf.loadAll();
    for (const name of ['team/mfe1', 'team/mfe2'])
      expect(loaded[name]!.seen).toEqual({
        '@angular/core': 'mfe1|@angular/core@22.1.0',
        '@angular/router': 'mfe1|@angular/router@22.1.0',
      });
    expect(nf.downloads()).toEqual([
      'http://mfe1/@angular/core.js',
      'http://mfe1/@angular/router.js',
    ]);

    // Last, because resolving in the host's scope is what fetches the host's own copy: the pin stands and
    // the host is never re-pointed at the majority build.
    expect(await nf.resolve('@angular/core', SCOPE.host)).toBe('host.service|@angular/core@22.0.5');
  });
});

/**
 * Which version the election picks, measured as files the browser actually fetched.
 *
 * Adding ONE previous-major remote to a healthy portfolio used to take the production capture from 36 to
 * 64 downloads and island 5 of 8 remotes, three of them healthy Angular-22 remotes islanded purely by
 * contagion. The cause was never the agreement gate — it fires on none of this — but `determine`'s
 * extra-download objective, which counted scoped **versions** rather than uncached remote **copies**. Two
 * patch-drifted legacy remotes therefore outvoted three modern remotes that all agreed on one tag,
 * `@angular/router`'s winner moved to the 21 line, and all-or-nothing islanding amplified that single
 * mis-election across the whole family.
 *
 * Weighting the objective per copy fixes the measured cause. The residual — the election is exact per
 * external but still evaluated *per external*, so two members can elect opposite winners — needs
 * asymmetric member sets to show, and is characterised in `asymmetric.e2e.spec.ts`.
 */
test.describe('symmetric: which version the election picks', () => {
  // The Angular-22 majority against a previous-major minority. `mfe3` is the one asymmetry the cost model
  // is indifferent to: it ships core alone, one patch behind, and dedups it throughout.
  const portfolio = (previousMajor: { name: string; scope: string; tag: string }[]) => [
    remote('team/mfe1', SCOPE.mfe1, [
      dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
      dep('@angular/router', '22.0.8', { req: '~22.0.3' }),
    ]),
    remote('team/mfe2', SCOPE.mfe2, [
      dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
      dep('@angular/router', '22.0.8', { req: '~22.0.3' }),
    ]),
    remote('team/mfe3', SCOPE.mfe3, [dep('@angular/core', '22.0.6', { req: '~22.0.5' })]),
    ...previousMajor.map(l =>
      remote(l.name, l.scope, [
        dep('@angular/core', l.tag, { req: '~21.2.0' }),
        dep('@angular/router', l.tag, { req: '~21.2.0' }),
      ])
    ),
  ];

  test('keeps the modern majority intact with one previous-major remote present', async ({
    nf,
  }) => {
    await nf.init(portfolio([{ name: 'team/mfe4', scope: SCOPE.mfe4, tag: '21.2.18' }]));

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
    expect(await nf.islands()).toEqual(['team/mfe4 on @angular/core@21.2.18']);

    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(4);
  });

  test('holds when a second previous-major remote joins on its own patch tag', async ({ nf }) => {
    // The cascade trigger: mfe5 adds a SECOND distinct 21 tag and nothing else. Counting versions,
    // router@22.0.8 cost 2 against each 21 version's 1, so the winner moved to the 21 line and islanded
    // mfe1 and mfe2 across their whole family. Counting copies, both sides cost 2 and the newest tag
    // keeps it.
    await nf.init(
      portfolio([
        { name: 'team/mfe4', scope: SCOPE.mfe4, tag: '21.2.18' },
        { name: 'team/mfe5', scope: SCOPE.mfe5, tag: '21.2.15' },
      ])
    );

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');

    // Only the two genuinely cross-major remotes island, each on a real range violation. mfe3 keeps
    // deduping core; the modern remotes are untouched.
    expect(await nf.islands()).toEqual([
      'team/mfe4 on @angular/core@21.2.18',
      'team/mfe5 on @angular/core@21.2.15',
    ]);
    expect(map.scopes).toEqual({
      [SCOPE.mfe4]: {
        '@angular/core': 'http://mfe4/@angular/core.js',
        '@angular/router': 'http://mfe4/@angular/router.js',
      },
      [SCOPE.mfe5]: {
        '@angular/core': 'http://mfe5/@angular/core.js',
        '@angular/router': 'http://mfe5/@angular/router.js',
      },
    });

    // 4 downloads with one previous-major remote, 6 with two — the honest price of two islands, and the
    // measurement the version-counting objective got wrong by a factor of two.
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(6);
    expect(await nf.buildsOf('@angular/core')).toHaveLength(3);
  });

  test('elects the older tag when it saves copies, and islands the lone modern remote', async ({
    nf,
  }) => {
    // The user-visible behaviour change. Three remotes share one 21.2.18 copy, one remote is on 22.0.8,
    // and the two are mutually incompatible. Counting versions, both candidates cost 1 and the newest
    // won; counting copies, 22.0.8 costs 3 against 21.2.18's 1, so the larger group wins — which is what
    // "fewest extra downloads" always claimed to mean.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
      remote('team/mfe3', SCOPE.mfe3, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
      remote('team/mfe4', SCOPE.mfe4, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe2/@angular/core.js');
    expect(map.scopes).toEqual({
      [SCOPE.mfe1]: { '@angular/core': 'http://mfe1/@angular/core.js' },
    });

    await nf.loadAll();
    expect(nf.downloads().sort()).toEqual([
      'http://mfe1/@angular/core.js',
      'http://mfe2/@angular/core.js',
    ]);
  });

  test('lets `profile.latestSharedExternal` opt out of the cost model entirely', async ({ nf }) => {
    // Same portfolio, opted out: the newest tag wins regardless of how many copies that costs, so the
    // three-remote majority pays for it instead. 4 downloads against 2.
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
        remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
        remote('team/mfe3', SCOPE.mfe3, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
        remote('team/mfe4', SCOPE.mfe4, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
      ],
      { profile: { latestSharedExternal: true } }
    );

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(Object.keys(map.scopes ?? {}).sort()).toEqual([SCOPE.mfe2, SCOPE.mfe3, SCOPE.mfe4]);

    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(4);
  });

  test('breaks a genuine tie toward the newest tag', async ({ nf }) => {
    // Equal copies on both sides, so the objective cannot separate them and the tiebreak decides.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/mfe3', SCOPE.mfe3, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
      remote('team/mfe4', SCOPE.mfe4, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
    ]);

    expect((await nf.map()).imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
  });

  test('never downloads a shared external twice, however many remotes import it', async ({
    nf,
  }) => {
    // What "shared" has to mean at the network layer: five remotes, one file, one request. If the map
    // pointed any of them at a different URL for the same external this would be five.
    const consumers = [SCOPE.mfe1, SCOPE.mfe2, SCOPE.mfe3, SCOPE.mfe4, SCOPE.mfe5].map((scope, i) =>
      remote(`team/mfe${i + 1}`, scope, [
        dep('@angular/core', '22.0.8', { req: '^22.0.0' }),
        dep('@angular/router', '22.0.8', { req: '^22.0.0' }),
      ])
    );
    await nf.init(consumers);
    await nf.loadAll();

    expect(nf.downloads()).toEqual([
      'http://mfe1/@angular/core.js',
      'http://mfe1/@angular/router.js',
    ]);
    expect(await nf.buildsOf('@angular/core')).toEqual(['mfe1|@angular/core@22.0.8']);
  });
});
