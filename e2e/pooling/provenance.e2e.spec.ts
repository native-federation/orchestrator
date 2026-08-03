import { test, expect } from '../harness/federation';
import { dep, remote, SCOPE, HOST_NAME } from '../harness/portfolio';
import type { RemoteEntry } from 'lib/core/1.domain';

/**
 * **The provenance promise, as it does not hold yet.**
 *
 * Every test in this file asserts *today's* behaviour, and today's behaviour is the defect: a remote is
 * served a coupled family assembled from builds that never shipped it together, is not islanded, and
 * nothing is logged. Six portfolios reproduce it in a real browser, and two further shapes generalize
 * them: the second hop (a torn provider) and manifest-order dependence.
 *
 * They are written this way deliberately. The promise — `docs/version-resolver.md` §"The provenance
 * promise" — is what these portfolios *should* do, so locking the wrong answer first is what makes the
 * fix falsifiable: every expectation below is inverted once the coverage rule lands, and an inversion
 * that does not go red is a fix that did not fix anything.
 *
 * Why no gate catches them: `findDisagreement` compares the builds a remote draws on *pairwise, on the
 * members both of them ship*. Cases 1–5 arrange an empty intersection, case 6 a nonempty one that omits
 * the coupled pair. Neither reaches the pair the consumer actually runs, because the build that relates
 * the two tags is the consumer's own — and that is never in the comparison.
 */

/** The consumer of both members, in every case below the remote that ends up running two builds. */
const consumesBoth = () =>
  remote('team/mfe3', SCOPE.mfe3, [
    dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
    dep('@angular/router', '22.0.5', { req: '^22.0.0' }),
  ]);

test.describe('provenance: the init path splits a family silently', () => {
  test('serves a consumer two builds that share no member', async ({ nf }) => {
    // Case 1, the minimal shape. mfe1 solely provides core, mfe2 solely provides router and its
    // `^22.1.0` wins router outright. The two serving builds are disjoint, so gate 2 compares nothing
    // and passes; mfe3 declares both, at 22.0.5, and is handed one of each.
    await nf.init([
      remote('team/mfe1', SCOPE.mfe1, [dep('@angular/core', '22.0.5', { req: '^22.0.0' })]),
      remote('team/mfe2', SCOPE.mfe2, [dep('@angular/router', '22.1.0', { req: '^22.1.0' })]),
      consumesBoth(),
    ]);

    // No verdict of any kind, and no scope: the map has nothing but the global winners.
    expect(await nf.islands()).toEqual([]);
    expect(await nf.warns()).toEqual([]);
    expect((await nf.map()).scopes).toBeUndefined();

    // BROKEN — this is the pair `asymmetric: the split family › islands across a minor gap` locks as a
    // must-island, reached by a route neither gate inspects. Under the promise mfe3 self-serves both.
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.0.5',
      '@angular/router': 'mfe2|@angular/router@22.1.0',
    });
  });

  test('reaches the opposite verdict on the same portfolio in a different manifest order', async ({
    nf,
  }) => {
    // Case 2, generalized to all six orderings of one three-remote portfolio — the shape the case
    // only showed in two. Nothing about the remotes changes between runs; only the order the manifest
    // lists them in.
    //
    // The serving basis of a member is its first non-islanded provider, i.e. arrival order. When the
    // consumer arrives before the other core provider it becomes core's basis, so its own build joins
    // the draw set and gate 2 finally has something to compare — router 22.0.5 against 22.1.0, a minor
    // gap, island. When it arrives after, mfe2 is the basis, the draw set is two disjoint builds, and
    // the identical split passes in silence.
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
    for (const [label, portfolio] of orderings) {
      // A namespace per ordering: each init is a fresh election rather than a warm start off the last.
      await nf.init(portfolio, { namespace: label });
      verdicts[label] = await nf.islands();
    }

    // BROKEN — constraint 12 says the same portfolio in any order yields the same verdict. Half of
    // these island the consumer and half serve it a split family without a word.
    const islanded = ['team/mfe3 mixes @angular/router 22.0.5 vs 22.1.0'];
    expect(verdicts).toEqual({
      'consumer, core, router': islanded,
      'consumer, router, core': islanded,
      'core, consumer, router': [],
      'core, router, consumer': [],
      'router, consumer, core': islanded,
      'router, core, consumer': [],
    });
    expect(new Set(Object.values(verdicts).map(v => v.length))).toEqual(new Set([0, 1]));
  });

  test('splits a family the host itself half-serves', async ({ nf }) => {
    // Case 3, the common real-world trigger: the host ships the framework core every remote
    // dedups, and some remote ships a newer router the host does not carry. Host precedence pins core
    // to the host's build, router resolves freely to mfe1's — and the two never shipped together.
    //
    // This is #63's own second repro with the one change that hides it: the router provider does not
    // ship core, so the consumer is not itself the router basis.
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

    expect(await nf.islands()).toEqual([]);
    expect(await nf.warns()).toEqual([]);

    // BROKEN — mfe2 runs the host's core against a router from a build that never saw it.
    expect((await nf.load('team/mfe2')).seen).toEqual({
      '@angular/core': 'host.service|@angular/core@22.0.5',
      '@angular/router': 'mfe1|@angular/router@22.1.0',
    });
  });
});

test.describe('provenance: the dynamic path mirrors it', () => {
  test('hands a late-loaded remote the same split, with an empty delta', async ({ nf }) => {
    // Case 4. `disagreementAcrossCommittedBuilds` passes the *committed* serving builds and, like
    // the init path, never compares the loaded remote's own build against them — so case 1 reproduces
    // through `initRemoteEntry` unchanged.
    const late = consumesBoth();
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [dep('@angular/core', '22.0.5', { req: '^22.0.0' })]),
        remote('team/mfe2', SCOPE.mfe2, [dep('@angular/router', '22.1.0', { req: '^22.1.0' })]),
      ],
      { unlisted: [late] }
    );

    await nf.initRemoteEntry(late.url);

    // The delta carries the exposed module and nothing else — no scope, so the late remote takes both
    // global winners.
    expect(await nf.map()).toEqual({ imports: { 'team/mfe3/./comp': 'http://mfe3/comp.js' } });
    expect(await nf.warns()).toEqual([]);

    // BROKEN — same two builds as case 1, decided by the dynamic gate this time.
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.0.5',
      '@angular/router': 'mfe2|@angular/router@22.1.0',
    });
  });
});

/**
 * The two cases that decide *which kind* of rule can close this, and rule out the two cheap ones.
 * Neither is reachable by comparing tags (case 5 has no shared version line to compare) or by
 * comparing the serving builds more tightly (case 6's builds agree exactly on everything they share).
 */
test.describe('provenance: the cases no tag comparison can reach', () => {
  test('lets a declared bridge-tag coupling constrain nothing', async ({ nf }) => {
    // Case 5. `docs/version-resolver.md` §"Declare the coupling you actually have" recommends
    // co-tagging a bridge member to express a coupling auto-pooling cannot see. Here it buys gate 1
    // only: a design-system remote ships design-system packages and a shell ships framework ones, so
    // the two serving builds are disjoint *by construction* and gate 2 can never fire on them.
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
    expect(await nf.warns()).toEqual([]);

    // BROKEN — mfe3 ships ui@2.0.0 beside core@22.0.5 and runs ui@2.1.0 beside core@22.1.0. The two
    // packages version independently, so no tag-distance rule has a line to compare: this is the case
    // that forces the fix to be framed around provenance instead.
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@ds/ui': 'mfe1|@ds/ui@2.1.0',
      '@angular/core': 'mfe2|@angular/core@22.1.0',
    });
  });

  test('splits a lockstep pair between two providers that agree exactly on their overlap', async ({
    nf,
  }) => {
    // Case 6, and the case that fixes the framing. Nothing is disjoint here: both serving builds
    // ship core@22.0.5 and agree on it *byte for byte*, so this survives any tightening of the
    // comparison — minor line, patch, or exact tag equality alike. The pair that matters, material
    // against cdk, is in neither build.
    //
    // material and cdk are one npm scope, so auto-pooling groups them, and they are a vendor lockstep
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

    expect(await nf.islands()).toEqual([]);
    expect(await nf.warns()).toEqual([]);

    // BROKEN. Note what the fix owes this case beyond the right answer: no build covers
    // {material, cdk}, so coverage alone moves mfe3 onto its own build — silently, because coverage is
    // not a verdict and logs nothing. Iteration 6 is what makes the self-serve visible.
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/material': 'mfe1|@angular/material@22.0.5',
      '@angular/cdk': 'mfe2|@angular/cdk@22.1.0',
    });
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
 * the anchor self-scope of `docs/version-resolver.md` §"The provenance promise" and not a change to
 * `ImportMap`.
 */
test.describe('provenance: the second hop', () => {
  const torn = () => [
    // mfe1 ships a matched core/router pair and its router really imports core.
    remote('team/mfe1', SCOPE.mfe1, [
      dep('@angular/core', '22.0.6', { req: '^22.0.0' }),
      dep('@angular/router', '22.0.6', { req: '^22.0.0', peers: ['@angular/core'] }),
    ]),
    // A newer core, one patch up. Copy counts tie, so the newest tag wins core globally and mfe1's own
    // core loses — while mfe1 stays unislanded, because 22.0.6 and 22.0.9 are one minor line.
    remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.9', { req: '^22.0.0' })]),
    // The consumer, which declares router alone.
    remote('team/mfe3', SCOPE.mfe3, [
      dep('@angular/router', '22.0.6', { req: '^22.0.0', peers: ['@angular/core'] }),
    ]),
  ];

  test('gives a consumer a coherent top-level family bound to a foreign peer', async ({ nf }) => {
    await nf.init(torn());
    await nf.loadAll();

    // Read at the top level the portfolio looks perfect: mfe3 consumes exactly one member and gets it
    // from one build. Every criterion stated over `seen` is satisfied.
    expect(await nf.islands()).toEqual([]);
    expect((await nf.load('team/mfe3')).seen).toEqual({
      '@angular/router': 'mfe1|@angular/router@22.0.6',
    });

    // BROKEN, one hop in — the router mfe3 runs is bound to a core from a different build. mfe1 has no
    // scope of its own (it is not islanded), so its router's `import '@angular/core'` falls through to
    // the global winner. mfe3 therefore runs router@22.0.6 against core@22.0.9: a pair no build in the
    // portfolio compiled, invisible to every assertion above.
    expect(await nf.bindings()).toEqual({
      'mfe1|@angular/router@22.0.6': { '@angular/core': 'mfe2|@angular/core@22.0.9' },
    });
  });

  test('tears mfe1 the same way on its own account', async ({ nf }) => {
    // The provider is not a bystander here: it is torn too, and this half *is* visible in `seen` —
    // today's rule tolerates it as patch drift on one minor line. Under the promise mfe1's family comes
    // from mfe1's build, which is also what repairs the consumer above: constraint 4's anchor
    // self-scope is the same map entry seen from the other side.
    await nf.init(torn());

    expect((await nf.load('team/mfe1')).seen).toEqual({
      '@angular/core': 'mfe2|@angular/core@22.0.9',
      '@angular/router': 'mfe1|@angular/router@22.0.6',
    });
  });

  test('reports nothing at all when the peer resolves inside the provider’s own scope', async ({
    nf,
  }) => {
    // The control, so the assertions above cannot pass by accident: give the provider a scope of its
    // own — here by islanding it on a real incompatibility — and the same peer edge binds its own core.
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

    expect(await nf.islands()).toEqual(['team/mfe1 on @angular/core@22.0.6']);
    expect(await nf.bindings()).toEqual({
      'mfe1|@angular/router@22.0.6': { '@angular/core': 'mfe1|@angular/core@22.0.6' },
    });
  });
});
