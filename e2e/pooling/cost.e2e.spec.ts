import { test, expect } from '../harness/federation';
import { dep, remote, SCOPE } from '../harness/portfolio';

/**
 * The download cost model underneath islanding, measured as files the browser actually fetched.
 *
 * Adding ONE previous-major remote to a healthy portfolio used to take the production capture from 36
 * to 64 downloads and island 5 of 8 remotes, three of them healthy Angular-22 remotes islanded purely
 * by contagion. The cause was never the agreement gate — it fires on none of this — but `determine`'s
 * extra-download objective, which counted scoped **versions** rather than uncached remote **copies**.
 * Two patch-drifted legacy remotes therefore outvoted three modern remotes that all agreed on one tag,
 * `@angular/router`'s winner moved to the 21 line, and all-or-nothing islanding amplified that single
 * mis-election across the whole family.
 *
 * Weighting the objective per copy fixes the measured cause. The residual — the election is exact per
 * external but still evaluated per external — is characterised at the bottom of this file.
 */
test.describe('cost: extra downloads counted per copy', () => {
  // The Angular-22 majority: mfe-a and mfe-b ship core + router at 22.0.8, mfe-c only core, one patch
  // behind. Each `legacy` entry is a previous-major remote, honestly pinned to its own minor line and
  // in conflict with nobody but the majority.
  const portfolio = (legacy: { name: string; scope: string; tag: string }[]) => [
    remote('team/mfe-a', SCOPE.a, [
      dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
      dep('@angular/router', '22.0.8', { req: '~22.0.3' }),
    ]),
    remote('team/mfe-b', SCOPE.b, [
      dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
      dep('@angular/router', '22.0.8', { req: '~22.0.3' }),
    ]),
    remote('team/mfe-c', SCOPE.c, [dep('@angular/core', '22.0.6', { req: '~22.0.5' })]),
    ...legacy.map(l =>
      remote(l.name, l.scope, [
        dep('@angular/core', l.tag, { req: '~21.2.0' }),
        dep('@angular/router', l.tag, { req: '~21.2.0' }),
      ])
    ),
  ];

  test('keeps the modern majority intact with one previous-major remote present', async ({
    nf,
  }) => {
    await nf.init(portfolio([{ name: 'team/legacy-a', scope: SCOPE.legacyA, tag: '21.2.18' }]));

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe-a/@angular/router.js');
    expect(await nf.islands()).toEqual(['team/legacy-a on @angular/core@21.2.18']);

    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(4);
  });

  test('holds when a second previous-major remote joins on its own patch tag', async ({ nf }) => {
    // The cascade trigger: legacy-b adds a SECOND distinct 21 tag and nothing else. Counting versions,
    // router@22.0.8 cost 2 against each 21 version's 1, so the winner moved to the 21 line and islanded
    // mfe-a and mfe-b across their whole family. Counting copies, both sides cost 2 and the newest tag
    // keeps it.
    await nf.init(
      portfolio([
        { name: 'team/legacy-a', scope: SCOPE.legacyA, tag: '21.2.18' },
        { name: 'team/legacy-b', scope: SCOPE.legacyB, tag: '21.2.15' },
      ])
    );

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe-a/@angular/router.js');

    // Only the two genuinely cross-major remotes island, each on a real range violation. mfe-c keeps
    // deduping core; the modern remotes are untouched.
    expect(await nf.islands()).toEqual([
      'team/legacy-a on @angular/core@21.2.18',
      'team/legacy-b on @angular/core@21.2.15',
    ]);
    expect(map.scopes).toEqual({
      [SCOPE.legacyA]: {
        '@angular/core': 'http://legacy-a/@angular/core.js',
        '@angular/router': 'http://legacy-a/@angular/router.js',
      },
      [SCOPE.legacyB]: {
        '@angular/core': 'http://legacy-b/@angular/core.js',
        '@angular/router': 'http://legacy-b/@angular/router.js',
      },
    });

    // 4 downloads with one legacy remote, 6 with two — the honest price of two islands, and the
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
    // won; counting copies, 22.0.8 costs 3 against 21.2.18's 1, so the larger group wins — which is
    // what "fewest extra downloads" always claimed to mean.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/legacy-a', SCOPE.legacyA, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
      remote('team/legacy-b', SCOPE.legacyB, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
      remote('team/legacy-c', SCOPE.legacyC, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://legacy-a/@angular/core.js');
    expect(map.scopes).toEqual({ [SCOPE.a]: { '@angular/core': 'http://mfe-a/@angular/core.js' } });

    await nf.loadAll();
    expect(nf.downloads().sort()).toEqual([
      'http://legacy-a/@angular/core.js',
      'http://mfe-a/@angular/core.js',
    ]);
  });

  test('lets `profile.latestSharedExternal` opt out of the cost model entirely', async ({ nf }) => {
    // Same portfolio, opted out: the newest tag wins regardless of how many copies that costs, so the
    // three-remote majority pays for it instead. 4 downloads against 2.
    await nf.init(
      [
        remote('team/mfe-a', SCOPE.a, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
        remote('team/legacy-a', SCOPE.legacyA, [
          dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        ]),
        remote('team/legacy-b', SCOPE.legacyB, [
          dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        ]),
        remote('team/legacy-c', SCOPE.legacyC, [
          dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        ]),
      ],
      { profile: { latestSharedExternal: true } }
    );

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
    expect(Object.keys(map.scopes ?? {}).sort()).toEqual([
      SCOPE.legacyA,
      SCOPE.legacyB,
      SCOPE.legacyC,
    ]);

    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(4);
  });

  test('breaks a genuine tie toward the newest tag', async ({ nf }) => {
    // Equal copies on both sides, so the objective cannot separate them and the tiebreak decides.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/mfe-b', SCOPE.b, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/legacy-a', SCOPE.legacyA, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
      remote('team/legacy-b', SCOPE.legacyB, [dep('@angular/core', '21.2.18', { req: '~21.2.0' })]),
    ]);

    expect((await nf.map()).imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
  });

  test('never downloads a shared external twice, however many remotes import it', async ({
    nf,
  }) => {
    // What "shared" has to mean at the network layer: five remotes, one file, one request. If the map
    // pointed any of them at a different URL for the same external this would be five.
    const consumers = [SCOPE.a, SCOPE.b, SCOPE.c, SCOPE.d, SCOPE.x].map((scope, i) =>
      remote(`team/mfe-${i}`, scope, [
        dep('@angular/core', '22.0.8', { req: '^22.0.0' }),
        dep('@angular/router', '22.0.8', { req: '^22.0.0' }),
      ])
    );
    await nf.init(consumers);
    await nf.loadAll();

    expect(nf.downloads()).toEqual([
      'http://mfe-a/@angular/core.js',
      'http://mfe-a/@angular/router.js',
    ]);
    expect(await nf.buildsOf('@angular/core')).toEqual(['mfe-a|@angular/core@22.0.8']);
  });
});

/**
 * CHARACTERISATION of what the F-A islanding-cascade follow-up leaves open: the objective is exact per
 * external, but it is still evaluated *per external*. Two members of one pool whose remote-count
 * majorities sit on different version lines still elect opposite winners, and pooling still amplifies
 * the split. A failure here is probably good news — read the follow-up before "repairing" it.
 */
test.describe('cost: residual — per-member elections can still split a pool', () => {
  test('splits a family when each member has its majority on a different line', async ({ nf }) => {
    // core's modern side is larger, router's legacy side is larger.
    await nf.init([
      remote('team/mfe-a', SCOPE.a, [
        dep('@angular/core', '22.0.8', { req: '~22.0.3' }),
        dep('@angular/router', '22.0.8', { req: '~22.0.3' }),
      ]),
      remote('team/mfe-b', SCOPE.b, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/mfe-c', SCOPE.c, [dep('@angular/core', '22.0.8', { req: '~22.0.3' })]),
      remote('team/legacy-a', SCOPE.legacyA, [
        dep('@angular/core', '21.2.18', { req: '~21.2.0' }),
        dep('@angular/router', '21.2.18', { req: '~21.2.0' }),
      ]),
      remote('team/legacy-b', SCOPE.legacyB, [
        dep('@angular/router', '21.2.18', { req: '~21.2.0' }),
      ]),
    ]);

    // Each winner is the cheaper one for its own member, and together they cost mfe-a its family.
    // core is still shared at 22.0.8 — but from mfe-b, because islanding mfe-a removed its copy and
    // with it the serving basis.
    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe-b/@angular/core.js');
    // Likewise router: shared at 21.2.18, served by legacy-b once legacy-a's copy is islanded away.
    expect(map.imports['@angular/router']).toBe('http://legacy-b/@angular/router.js');
    expect(await nf.islands()).toEqual([
      'team/legacy-a on @angular/core@21.2.18',
      'team/mfe-a on @angular/router@22.0.8',
    ]);

    // The residual is a cost problem, not a coherence one: every remote still runs one build per
    // family. mfe-b is the remote to watch — it dedups core@22.0.8 and ships no router at all.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe-a']!.seen).toEqual({
      '@angular/core': 'mfe-a|@angular/core@22.0.8',
      '@angular/router': 'mfe-a|@angular/router@22.0.8',
    });
    expect(loaded['team/legacy-b']!.seen).toEqual({
      '@angular/router': 'legacy-b|@angular/router@21.2.18',
    });
  });
});
