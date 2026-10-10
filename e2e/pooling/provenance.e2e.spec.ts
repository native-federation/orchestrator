import { test, expect } from '../harness/federation';
import { dep, remote, SCOPE, HOST_NAME } from '../harness/portfolio';
import type { RemoteEntry } from 'lib/core/1.domain';

/**
 * **The provenance promise, as it now holds.** `docs/version-resolver.md` §"How pooling resolves".
 *
 * Six portfolios in which a remote was served a coupled family assembled from builds that never shipped
 * it together — not islanded, nothing logged — plus two shapes that generalize them: the second hop (a
 * torn provider) and manifest-order dependence. Each is closed here, in a real browser, and each ends
 * with the consumer running **one build, or every member at its own declared tag**.
 *
 * Every expectation below was written the other way round first, locking the broken answer, because that
 * is what makes the fix falsifiable: an inversion that does not go red is a fix that did not fix
 * anything. The docblocks record what each portfolio used to do and what it cost to repair.
 *
 * Why no gate caught them, which is why the portfolios are shaped the way they are: `findDisagreement`
 * compared the builds a remote draws on *pairwise, on the members both of them ship*. Cases 1–5 arrange
 * an empty intersection, case 6 a nonempty one that omits the coupled pair. Neither reaches the pair the
 * consumer actually runs, because the build that relates the two tags is the consumer's own — and that
 * was never in the comparison. The coverage rule does not compare serving builds with each other at all:
 * it asks whether *one* build offers everything the consumer imports, at versions the consumer accepts.
 */

/** The consumer of both members, in every case below the remote that ends up running two builds. */
const consumesBoth = () =>
  remote('team/mfe3', SCOPE.mfe3, [
    dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
    dep('@angular/router', '22.0.5', { req: '^22.0.0' }),
  ]);

test.describe('provenance: the init path keeps a family on one build', () => {
  test('serves a consumer its own build when no shared build ships both members', async ({
    nf,
  }) => {
    // Case 1, the minimal shape. mfe1 solely provides core, mfe2 solely provides router and its
    // `^22.1.0` wins router outright. The two serving builds are disjoint, so gate 2 compared nothing and
    // passed; mfe3 declares both at 22.0.5 and was handed one of each — silently, with no scope in the
    // map at all, the pair `asymmetric: the split family › islands across a minor gap` locks as a
    // must-island, reached by a route neither gate inspected.
    //
    // Under the gate pipeline mfe3 took its whole family from its own build (4 downloads). Electing the
    // family, mfe3's own build serves mfe1 too, so it is the global one; only mfe2, whose ^22.1.0 rejects
    // router@22.0.5, runs its own router. 3 downloads, and mfe3 runs exactly the pair it shipped.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [dep('@angular/core', '22.0.5', { req: '^22.0.0' })]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/router', '22.1.0', { req: '^22.1.0' })]),
      consumesBoth(),
    ]);

    expect(await nf.islands()).toEqual(['team/mfe2 incompatible']);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe3/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe3/@angular/router.js');
    expect(map.scopes).toEqual({
      [SCOPE.mfe2]: { '@angular/router': 'http://mfe2/@angular/router.js' },
    });

    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@22.0.5',
      '@angular/router': 'mfe3|@angular/router@22.0.5',
    });
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(3);
  });

  test('reaches the same verdict on the same portfolio in every manifest order', async ({ nf }) => {
    // Case 2, generalized to all six orderings of one three-remote portfolio — the shape the case only
    // showed in two. Nothing about the remotes changes between runs; only the order the manifest lists
    // them in.
    //
    // What the old promise did, and constraint 12 is written against: the serving basis of a member is its
    // first non-islanded provider, i.e. arrival order. When the consumer arrived before the other core
    // provider it became core's basis, so its own build joined the draw set and gate 2 finally had
    // something to compare — router 22.0.5 against 22.1.0, a minor gap, island. When it arrived after,
    // mfe2 was the basis, the draw set was two disjoint builds, and the identical split passed in silence.
    // Three of six orderings islanded the consumer, three served it a torn family.
    //
    // The election does not read arrival order here: the consumer's build serves the core-only remote in
    // every ordering, so all six elect it and island the router-only remote, down to the sentence.
    const consumer = consumesBoth();
    const coreOnly = remote('team/mfe2', SCOPE.mfe2, [
      dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
    ]);
    const routerOnly = remote('team/mfe1', SCOPE.mfe1, [
      dep('@angular/router', '22.1.0', { req: '^22.1.0' }),
    ]);

    const orderings: [string, RemoteEntry[]][] = [
      ['consumer, core, router', [consumer, coreOnly, routerOnly]],
      ['consumer, router, core', [consumer, routerOnly, coreOnly]],
      ['core, consumer, router', [coreOnly, consumer, routerOnly]],
      ['core, router, consumer', [coreOnly, routerOnly, consumer]],
      ['router, consumer, core', [routerOnly, consumer, coreOnly]],
      ['router, core, consumer', [routerOnly, coreOnly, consumer]],
    ];

    const verdicts: Record<string, string[]> = {};
    const reports: Record<string, string[]> = {};
    for (const [label, portfolio] of orderings) {
      // A namespace per ordering: each init is a fresh election rather than a warm start off the last.
      await nf.init(portfolio, { namespace: label });
      verdicts[label] = await nf.islands();
      reports[label] = await nf.warns();
    }

    const selfServes = ['team/mfe1 incompatible'];
    expect(verdicts).toEqual({
      'consumer, core, router': selfServes,
      'consumer, router, core': selfServes,
      'core, consumer, router': selfServes,
      'core, router, consumer': selfServes,
      'router, consumer, core': selfServes,
      'router, core, consumer': selfServes,
    });

    // Down to the sentence: one warning per ordering, naming the same gap and the same closest build.
    // A verdict that agreed while the report drifted would still churn the map across inits.
    expect(new Set(Object.values(reports).map(warns => JSON.stringify(warns))).size).toBe(1);
    // The wording itself is pinned in island-warnings.contract.spec.ts.
    expect(reports['core, router, consumer']).toHaveLength(1);
  });

  test('gives way on the consumer, never on the host, when the host half-serves a family', async ({
    nf,
  }) => {
    // Case 3, the common real-world trigger: the host ships the framework core every remote dedups, and
    // some remote ships a newer router the host does not carry. Host precedence pins core to the host's
    // build, router resolves freely to mfe1's — and the two never shipped together, so mfe2 used to run
    // that pair with no verdict and no warning.
    //
    // This is #63's own second repro with the one change that hid it: the router provider does not ship
    // core, so the consumer is not itself the router basis. The host's build is round 1 whatever it serves,
    // and both remotes agree with it — but they ship router at two tags, so router is not published for
    // either. mfe2 takes the host's core (its own 22.0.5) and runs its own router beside it, never mfe1's
    // 22.1.0; mfe1 runs its own router. 3 downloads.
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [dep('@angular/router', '22.1.0', { req: '^22.1.0' })]),
        remote('team/mfe2', SCOPE.mfe2, [
          dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
          dep('@angular/router', '22.0.5', { req: '^22.0.0' }),
        ]),
      ],
      {
        hostEntry: remote(HOST_NAME, SCOPE.host, [
          dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
        ]),
      }
    );

    expect(await nf.islands()).toEqual(['team/mfe1 uncovered', 'team/mfe2 uncovered']);

    // The host's pin owns the global mapping; router is in nobody's global set.
    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://host.service/@angular/core.js');
    expect(map.imports['@angular/router']).toBeUndefined();
    expect(map.scopes).toEqual({
      [SCOPE.mfe1]: { '@angular/router': 'http://mfe1/@angular/router.js' },
      [SCOPE.mfe2]: { '@angular/router': 'http://mfe2/@angular/router.js' },
    });

    expect((await nf.load('team/mfe2')).seen).toEqual({
      '@angular/core': 'host.service|@angular/core@22.0.5',
      '@angular/router': 'mfe2|@angular/router@22.0.5',
    });
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(3);
  });
});

test.describe('provenance: the dynamic path mirrors it', () => {
  test('makes a late-loaded remote serve the family no committed build ships', async ({ nf }) => {
    // Case 4, inverted. The old dynamic gate compared the *committed* serving builds with each other and,
    // like the init path, never asked what the loaded remote's own build shipped — so case 1 reproduced
    // through `initRemoteEntry` unchanged, with an empty delta hiding it. The dynamic gate now asks the
    // same question as the init one: is the combination the committed map would hand this remote one that
    // some build shipped? Two disjoint builds ship no such combination, so mfe3 serves its own family and
    // the delta says so.
    const late = consumesBoth();
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [dep('@angular/core', '22.0.5', { req: '^22.0.0' })]),
        remote('team/mfe2', SCOPE.mfe2, [dep('@angular/router', '22.1.0', { req: '^22.1.0' })]),
      ],
      { unlisted: [late] }
    );

    await nf.initRemoteEntry(late.url);

    // The delta is additive: the exposed module, plus a scope naming mfe3's own two files.
    expect(await nf.map()).toEqual({
      imports: { 'team/mfe3/./comp': 'http://mfe3/comp.js' },
      scopes: {
        [SCOPE.mfe3]: {
          '@angular/core': 'http://mfe3/@angular/core.js',
          '@angular/router': 'http://mfe3/@angular/router.js',
        },
      },
    });

    // FIXED — one build, its own, where it used to run one member from each of two.
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/core': 'mfe3|@angular/core@22.0.5',
      '@angular/router': 'mfe3|@angular/router@22.0.5',
    });
  });
});

/**
 * The two cases that decide *which kind* of rule can close this, and rule out the two cheap ones.
 * Neither is reachable by comparing tags (case 5 has no shared version line to compare) or by
 * comparing the serving builds more tightly (case 6's builds agree exactly on everything they share).
 */
test.describe('provenance: the cases no tag comparison can reach', () => {
  test('makes a declared bridge-label coupling constrain what the labeller runs', async ({
    nf,
  }) => {
    // Case 5. `docs/version-resolver.md` §"Declare the coupling you actually have" recommends co-labelling a
    // bridge member to express a coupling scope labelling cannot see. Under the old promise the label bought
    // gate 1 only: a design-system remote ships design-system packages and a shell ships framework ones,
    // so the two serving builds are disjoint *by construction* and gate 2 could never fire on them — the
    // declaration was honoured by grouping the members and then ignored.
    //
    // The election makes it mean something: mfe3 declared the coupling, and its build — ui@2.0.0 beside
    // core@22.0.5 — is the one that serves all three remotes (both ranges take it), so everybody runs the
    // pair mfe3 shipped. 2 downloads; the gate pipeline paid 4 to give mfe3 its own.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [dep('@ds/ui', '2.1.0', { req: '^2.0.0', pool: 'ng-ds' })]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.1.0', { req: '^22.0.0', pool: 'ng-ds' }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep('@ds/ui', '2.0.0', { req: '^2.0.0', pool: 'ng-ds' }),
        dep('@angular/core', '22.0.5', { req: '^22.0.0', pool: 'ng-ds' }),
      ]),
    ]);

    expect(await nf.islands()).toEqual([]);

    // mfe3 shipped ui@2.0.0 beside core@22.0.5 and once ran ui@2.1.0 beside core@22.1.0. The two packages
    // version independently, so no tag-distance rule has a line to compare here — which is the case that
    // forced the fix to be framed around provenance. Now it runs the pair it shipped.
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@ds/ui': 'mfe3|@ds/ui@2.0.0',
      '@angular/core': 'mfe3|@angular/core@22.0.5',
    });
    expect((await nf.map()).scopes).toBeUndefined();
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(2);
  });

  test('keeps a lockstep pair together though both providers agree exactly on their overlap', async ({
    nf,
  }) => {
    // Case 6, and the case that fixes the framing. Nothing is disjoint here: both serving builds ship
    // core@22.0.5 and agree on it *byte for byte*, so the old verdict survives any tightening of the
    // comparison — minor line, patch, or exact tag equality alike. The pair that matters, material against
    // cdk, is in neither build. mfe1's build is elected (both others agree with it), and cdk — shipped at
    // two tags by the remotes that agree — is published for neither, so each keeps its own beside the
    // elected files it matches. 4 downloads; the gate pipeline paid 5.
    //
    // material and cdk are one npm scope, so scope labelling groups them, and they are a vendor lockstep
    // pair: 22.0.5 against 22.1.0 is a combination the vendor never shipped.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
        dep('@angular/material', '22.0.5', { req: '^22.0.0' }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [
        dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
        dep('@angular/cdk', '22.1.0', { req: '^22.1.0' }),
      ]),
      remote('team/mfe3', SCOPE.mfe3, [
        dep('@angular/material', '22.0.5', { req: '^22.0.0' }),
        dep('@angular/cdk', '22.0.5', { req: '^22.0.0' }),
      ]),
    ]);

    expect(await nf.islands()).toEqual(['team/mfe2 uncovered', 'team/mfe3 uncovered']);

    // material, cdk and core are one pool labelled `angular`.
    const store = await nf.store();
    expect(
      ['@angular/core', '@angular/material', '@angular/cdk'].map(
        name => store['__GLOBAL__']![name]!.poolName
      )
    ).toEqual(['angular', 'angular', 'angular']);

    // Each runs exactly the tags its own build shipped: the lockstep pair stays 22.0.5 for mfe3, and mfe2's
    // cdk@22.1.0 never meets mfe3's material.
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/material': 'mfe1|@angular/material@22.0.5',
      '@angular/cdk': 'mfe3|@angular/cdk@22.0.5',
    });
    expect((await nf.load('team/mfe2')).seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.0.5',
      '@angular/cdk': 'mfe2|@angular/cdk@22.1.0',
    });
    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(4);
  });
});

/**
 * The hop below everything above. `load()`'s `seen` reports the consumer's *own* top-level resolution,
 * and a consumer's import-map scope governs only the consumer's own imports — so when the build serving
 * it imports a sibling, the importer is the *provider's* origin and that import resolves in the
 * provider's scope, falling through to the global winner.
 *
 * Until now no fixture could show this: `externalModule` made every external a leaf, so a torn provider
 * passed green. `dep(..., { peers })` gives an external real imports, and `nf.bindings()` reports what
 * they bound to. Measured independently with handcrafted import maps in Chromium: a scope entry pointing
 * at another origin's build does beat the global `imports` for importers under that prefix, so the fix is
 * the subpool build's self-scope of `docs/version-resolver.md` §"How pooling resolves" and not a change to
 * `ImportMap`.
 */
test.describe('provenance: the second hop', () => {
  const torn = () => [
    // mfe1 ships a matched core/router pair and its router really imports core.
    remote('team/mfe1', SCOPE.mfe1, [
      dep('@angular/core', '22.0.6', { req: '^22.0.0' }),
      dep('@angular/router', '22.0.6', { req: '^22.0.0', peers: ['@angular/core'] }),
    ]),
    // Two remotes one patch up on core alone. Copies tie 2–2, so the newest tag wins core globally and
    // mfe1's own core loses it — the old rule left mfe1 unislanded, 22.0.6 and 22.0.9 being one minor line.
    remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.9', { req: '^22.0.0' })]),
    remote('team/mfe4', SCOPE.mfe4, [dep('@angular/core', '22.0.9', { req: '^22.0.0' })]),
    // The consumer of mfe1's router. It declares the core its router imports, as a real remote entry must:
    // anything externalized is in the entry, so `remote()` rejects a peer the entry does not declare.
    remote('team/mfe3', SCOPE.mfe3, [
      dep('@angular/core', '22.0.6', { req: '^22.0.0' }),
      dep('@angular/router', '22.0.6', { req: '^22.0.0', peers: ['@angular/core'] }),
    ]),
  ];

  test('binds the router it serves to the core of the same build, one hop in', async ({ nf }) => {
    // Inverted by the promise, and this is the assertion that made the fix falsifiable. Before it, mfe1
    // was not islanded — 22.0.6 and 22.0.9 are one minor line — so it had no scope of its own and its
    // router's `import '@angular/core'` fell through to the global winner: every consumer of that router
    // ran it against core@22.0.9, a pair nothing compiled, invisible in `seen`.
    //
    // Electing the family, mfe1's matched pair serves all four remotes (^22.0.0 takes 22.0.6), so it is the
    // global map and its router binds its own core through `imports`, whoever imports it.
    await nf.init(torn());
    await nf.loadAll();

    const map = await nf.map();
    expect(map.scopes).toBeUndefined();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
    expect((await nf.bindings())['mfe1|@angular/router@22.0.6']).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.0.6',
    });

    // And the consumer rides that build coherently: mfe3 resolves both members from mfe1. One router copy
    // exists on the page, so there is nothing else to bind.
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.0.6',
      '@angular/router': 'mfe1|@angular/router@22.0.6',
    });
    expect(await nf.bindings()).toEqual({
      'mfe1|@angular/router@22.0.6': { '@angular/core': 'mfe1|@angular/core@22.0.6' },
    });
    expect(nf.downloads()).toHaveLength(2);
  });

  test('keeps the provider own family on its own build', async ({ nf }) => {
    // The other half of the same repair, and the one visible in `seen`: mfe1 drew core@22.0.9 from mfe2
    // while running its own router@22.0.6, which the old rule tolerated as patch drift on one minor line.
    await nf.init(torn());

    expect((await nf.load('team/mfe1')).seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.0.6',
      '@angular/router': 'mfe1|@angular/router@22.0.6',
    });
  });

  test('reports nothing at all when the peer resolves inside the provider’s own scope', async ({
    nf,
  }) => {
    // The control, so the assertions above cannot pass by accident: give the provider a scope of its
    // own — here by islanding it: the two 21.2.0 remotes outnumber it and its ~22.0.6 rejects their build —
    // and the same peer edge binds its own core.
    // `bindings()` is reporting the map, not the fixture.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [
        dep('@angular/core', '22.0.6', { req: '~22.0.6' }),
        dep('@angular/router', '22.0.6', { req: '~22.0.6', peers: ['@angular/core'] }),
      ]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '21.2.0', { req: '~21.2.0' })]),
      remote('team/mfe3', SCOPE.mfe3, [dep('@angular/core', '21.2.0', { req: '~21.2.0' })]),
    ]);
    await nf.loadAll();

    expect(await nf.islands()).toEqual(['team/mfe1 incompatible']);
    expect(await nf.bindings()).toEqual({
      'mfe1|@angular/router@22.0.6': { '@angular/core': 'mfe1|@angular/core@22.0.6' },
    });
  });
});
