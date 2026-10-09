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

    expect(await nf.islands()).toEqual(['team/mfe2 incompatible']);

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

    expect(await nf.islands()).toEqual(['team/mfe2 incompatible']);
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
    // Membership here is by declared `pool` label, with scope labelling off: a design system opting into being
    // coupled to the framework it is built against. The label mechanism is `membership.e2e.spec.ts`; that
    // the flag does not change this verdict is `flag.e2e.spec.ts`.
    const labelled = (pkg: string, version: string, req: string) =>
      dep(pkg, version, { req, pool: 'framework' });

    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [
          labelled('@framework/core', '18.0.0', '^18.0.0'),
          labelled('@design-system/ui', '1.0.0', '^1.0.0'),
        ]),
        remote('team/mfe2', SCOPE.mfe2, [
          labelled('@framework/core', '17.0.0', '^17.0.0'),
          labelled('@design-system/ui', '1.0.0', '^1.0.0'),
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
    expect(await nf.islands()).toEqual(['team/mfe2 incompatible']);

    // The whole point, measured: the page runs two design systems, each against the framework it was
    // built for. Two copies is the cost of coherence here, not a leak.
    await nf.loadAll();
    expect(await nf.buildsOf('@design-system/ui')).toEqual([
      'mfe1|@design-system/ui@1.0.0',
      'mfe2|@design-system/ui@1.0.0',
    ]);
  });

  test('islands every incompatible remote independently', async ({ nf }) => {
    // Three majors in one family: the 22 majority wins round 1, and the two laggards each self-serve their
    // own whole family. Islands are per remote — one remote's island never drags a compatible one in.
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
    expect(await nf.islands()).toEqual(['team/mfe3 incompatible', 'team/mfe4 incompatible']);

    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(6);
    expect(await nf.buildsOf('@angular/core')).toEqual([
      'mfe1|@angular/core@22.0.8',
      'mfe3|@angular/core@21.2.18',
      'mfe4|@angular/core@20.1.0',
    ]);
  });

  test('splits two against two: the newest line wins and the losers share one build', async ({
    nf,
  }) => {
    // A symmetric portfolio with no majority. Two remotes pin `~22.1.0`, two pin `22.0.5` exactly, and
    // neither range accepts the other's tag — so round 1 is a tie at two remotes a side and the newest
    // build decides. The losing pair leaves round 1 whole, and a later round puts it in one subpool.
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
      'team/mfe3 subpool team/mfe3',
      'team/mfe4 subpool team/mfe3',
    ]);

    // The two losers share mfe3's build through their scopes — under the gate pipeline each ran its own,
    // and the page held three builds of core for four remotes; now it holds two.
    expect(map.scopes?.[SCOPE.mfe4]).toEqual({
      '@angular/core': 'http://mfe3/@angular/core.js',
      '@angular/router': 'http://mfe3/@angular/router.js',
    });

    const loaded = await nf.loadAll();
    expect(loaded['team/mfe4']!.seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@22.0.5',
      '@angular/router': 'mfe3|@angular/router@22.0.5',
    });
    expect(await nf.buildsOf('@angular/core')).toHaveLength(2);
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
    // build* rather than downloading a second copy of the same two files. Subpools are what make that
    // possible; a single global build has none to offer mfe2 but the host's. Under variant election the
    // host's build is round 1, and mfe2 joins mfe1's subpool: still 2 downloads. Every
    // remote outside round 1 is reported, and router — which the host does not ship and neither remote
    // agrees with the host on core to publish — lives in their scopes.
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

    expect(await nf.islands()).toEqual([
      'team/mfe1 subpool team/mfe1',
      'team/mfe2 subpool team/mfe1',
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://host.service/@angular/core.js');
    expect(map.imports['@angular/router']).toBeUndefined();
    expect(map.scopes?.[SCOPE.mfe1]).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
      '@angular/router': 'http://mfe1/@angular/router.js',
    });
    expect(map.scopes?.[SCOPE.mfe2]).toEqual({
      '@angular/core': 'http://mfe1/@angular/core.js',
      '@angular/router': 'http://mfe1/@angular/router.js',
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
 * Which version the election picks, measured as files the browser actually fetched. The islanding
 * cascade (a previous-major minority islanding the majority) and the split family are guarded in
 * `src/lib/core/2.app/steps/pooling/pooling.regression.spec.ts`, under the no-tear oracle.
 */
test.describe('symmetric: which version the election picks', () => {
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
