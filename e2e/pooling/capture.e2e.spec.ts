import { test, expect, type Federation } from '../harness/federation';
import { fixture, CAPTURED_SEVEN, type FixtureName } from '../harness/portfolio';
import {
  angularLinesPerRemote,
  angularTags as angularTagsIn,
  rootOf,
  sharedTags as sharedTagsIn,
  splitPackages as splitPackagesIn,
} from '../harness/coherence';

/**
 * The recorded portfolios in `e2e/fixtures` — seven anonymized production remoteEntries plus four
 * synthetic siblings — driven through the real init flow in a real browser.
 *
 * Everything else in this folder is a two- or three-remote fixture built to isolate one rule. This file
 * is the opposite: real entries, 6–37 shared externals each, multi-entrypoint packages, `pool` tags on
 * some remotes and not others, a non-global share scope, chunk bundles, and one remote still on the
 * older sparse remoteEntry format. It is the check that the rules compose on input nobody designed for
 * them — and, because every remote's exposed module is really loaded, that the resulting map is one a
 * browser can actually run.
 *
 * The remotes are `mfe1`–`mfe11`, numbered as recorded and carrying nothing in their names.
 * `fixtures/README.md` maps each to the scenario it holds; the four this file leans on repeatedly:
 *
 * - `mfe1` — the cross-major outlier (Angular 21.2.18, flat/sparse externals, flat chunks, 37 of them),
 *   and the sole provider of `animations`, `compiler`, `platform-browser-dynamic`, `forms/signals`
 * - `mfe2` — Angular 22.0.8 with `@angular/cdk/*` exact-pinned at 22.0.6, no `pool` tags
 * - `mfe8` — a second previous-major remote, one patch off `mfe1` (21.2.15)
 * - `mfe11` — the widest Angular set of any remote, entirely from one older-but-consistent 22.0.6 build
 */

// Pooling is on throughout: what these portfolios do with it off is `flag.e2e.spec.ts`.
const run = (nf: Federation, names: FixtureName[], opts: { namespace?: string } = {}) =>
  nf.init(names.map(fixture), { namespace: 'capture', ...opts });

// The measures live in `harness/coherence.ts`, shared with the file that runs these portfolios with
// the flag off; here they always read the `capture` namespace.
const sharedTags = (nf: Federation, namespace = 'capture') => sharedTagsIn(nf, namespace);
const angularTags = (nf: Federation, namespace = 'capture') => angularTagsIn(nf, namespace);
const splitPackages = (nf: Federation, namespace = 'capture') => splitPackagesIn(nf, namespace);

test.describe('capture: the captured seven', () => {
  test('serves the whole Angular family from one major, on two patch tags', async ({ nf }) => {
    await run(nf, CAPTURED_SEVEN);

    // Six of the seven remotes run Angular 22; one runs 21.2.18 and is the only one islanded. What
    // stays shared is 22 throughout — `22.0.8` for the core packages and `22.0.6` for the two
    // material/cdk consumers, which is legitimate patch drift on one minor line.
    expect(await angularTags(nf)).toEqual({
      '@angular/common': '22.0.8',
      '@angular/common/http': '22.0.8',
      '@angular/core': '22.0.8',
      '@angular/core/event-dispatch-contract.min.js': '22.0.8',
      '@angular/core/primitives/di': '22.0.8',
      '@angular/core/primitives/event-dispatch': '22.0.8',
      '@angular/core/primitives/signals': '22.0.8',
      '@angular/core/rxjs-interop': '22.0.8',
      '@angular/elements': '22.0.8',
      '@angular/forms': '22.0.8',
      '@angular/platform-browser': '22.0.8',
      '@angular/router': '22.0.8',
      '@angular/cdk/dialog': '22.0.6',
      '@angular/cdk/overlay': '22.0.6',
      '@angular/cdk/portal': '22.0.6',
      '@angular/material': '22.0.6',
    });
    expect(await splitPackages(nf)).toEqual({});
  });

  test('islands exactly one remote, on a real range violation', async ({ nf }) => {
    await run(nf, CAPTURED_SEVEN);

    // The cross-major remote cannot use the shared 22 build, so it serves its own 21.2.18 family.
    // Nothing else islands: several remotes legitimately draw from two or three builds that agree at
    // minor granularity, and those are left alone.
    expect(await nf.islands()).toEqual(['team/mfe1 on @angular/common@21.2.18']);
    expect((await nf.warns()).filter(msg => msg.includes('disagree on'))).toEqual([]);
    expect(
      (await nf.debugs()).filter(msg => msg.includes('agreeing builds')).length
    ).toBeGreaterThan(0);
  });

  test('gives every remote a runnable, single-line Angular family', async ({ nf }) => {
    // The end of the contract: each remote's exposed module statically imports all 6–37 entrypoints its
    // remoteEntry declares, so this loading at all means every declared external resolved. What it then
    // holds is one Angular minor line per remote — 22.0 for the six modern remotes, 21.2 for the island.
    await run(nf, CAPTURED_SEVEN);

    const loaded = await nf.loadAll();
    expect(angularLinesPerRemote(loaded)).toEqual({
      'team/mfe1': ['21.2'],
      'team/mfe2': ['22.0'],
      'team/mfe3': ['22.0'],
      'team/mfe4': ['22.0'],
      'team/mfe5': ['22.0'],
      'team/mfe6': ['22.0'],
      'team/mfe7': ['22.0'],
    });

    // Exactly six packages exist at two versions on the page, and they are precisely the Angular
    // members the islanded remote also ships: the shared 22.0.8 build plus the island's 21.2.18 one.
    // Nothing else is duplicated — the island costs one copy per member it shares, and no more.
    const versionsPerPackage: Record<string, Set<string>> = {};
    for (const copy of await nf.copies())
      (versionsPerPackage[rootOf(copy.pkg)] ??= new Set()).add(copy.version);
    expect(
      Object.entries(versionsPerPackage)
        .filter(([, versions]) => versions.size > 1)
        .map(([pkg]) => pkg)
        .sort()
    ).toEqual([
      '@angular/common',
      '@angular/core',
      '@angular/elements',
      '@angular/forms',
      '@angular/platform-browser',
      '@angular/router',
    ]);

    // And the island is scoped to the pool it was islanded from, not to the remote: mfe1
    // serves its own Angular family but still dedups `rxjs` from the modern majority, because rxjs is
    // unscoped and therefore in no pool with `@angular/*`.
    expect(loaded['team/mfe1']!.seen['rxjs']).toBe('mfe3|rxjs@7.8.2');
    expect(loaded['team/mfe1']!.seen['@angular/core']).toBe('mfe1|@angular/core@21.2.18');
  });
});

test.describe('capture: one more previous-major remote joins', () => {
  test('islands only the two cross-major remotes, not the modern majority', async ({ nf }) => {
    // The download objective's stress case. `mfe8` runs Angular 21.2.15 — a second, distinct
    // 21 patch tag — and conflicts with nobody the other remotes care about. When extra downloads were
    // counted per *version* rather than per remote copy, the two 21 versions outvoted the three modern
    // remotes that all agreed on 22.0.8: `@angular/router`'s winner moved to the 21 line, the modern
    // remotes' own copies became incompatible with it, and whole-family islanding spread that single
    // mis-election across five of eight remotes.
    //
    // Counting copies, both sides cost the same and the newest tag keeps it, so only the two remotes
    // that genuinely cannot use Angular 22 island.
    await run(nf, [...CAPTURED_SEVEN, 'mfe8']);

    expect(await nf.islands()).toEqual([
      'team/mfe1 on @angular/common@21.2.18',
      'team/mfe8 on @angular/common@21.2.15',
    ]);

    const scopedRemotes = Object.values(await nf.store('capture'))
      .flatMap(externals => Object.values(externals))
      .flatMap(external => external.versions.filter(v => v.action === 'scope'))
      .flatMap(v => v.remotes.map(r => r.name));
    expect([...new Set(scopedRemotes)].sort()).toEqual(['team/mfe1', 'team/mfe8']);

    // The shared Angular set is untouched by their arrival.
    expect(new Set(Object.values(await angularTags(nf)))).toEqual(new Set(['22.0.8', '22.0.6']));
    expect(await splitPackages(nf)).toEqual({});

    // The two islands are on distinct patch tags, so each runs its own build rather than sharing one.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe1']!.seen['@angular/core']).toBe('mfe1|@angular/core@21.2.18');
    expect(loaded['team/mfe8']!.seen['@angular/core']).toBe('mfe8|@angular/core@21.2.15');
  });
});

test.describe('capture: the synthetic siblings', () => {
  test('keeps a consistent older superset remote fully deduped', async ({ nf }) => {
    // `mfe11` ships the widest Angular set of any remote, entirely from one 22.0.6 build, with loose
    // `^22.0.0` ranges. It can take the shared 22.0.8/22.0.6 build wholesale, so it must not island —
    // a family deduping down to one older-but-consistent build is exactly what sharing is for.
    await run(nf, [...CAPTURED_SEVEN, 'mfe11']);

    expect(await nf.islands()).toEqual(['team/mfe1 on @angular/common@21.2.18']);
    expect(await splitPackages(nf)).toEqual({});

    // What it keeps of its own build is only what nobody else can serve, and it stays on one line.
    const loaded = await nf.loadAll();
    expect(angularLinesPerRemote(loaded)['team/mfe11']).toEqual(['22.0']);
    expect(
      [
        ...new Set(Object.values(loaded['team/mfe11']!.seen).filter(id => id.startsWith('mfe11|'))),
      ].sort()
    ).toEqual([
      // material, which mfe11 solely provides...
      'mfe11|@angular/material@22.0.6',
      // ...and platform-browser's `/animations` entrypoints. The elected platform-browser build is
      // mfe2's 22.0.8, which declares only the root entrypoint, so the two it does not
      // cover are self-filled from mfe11 — see `entrypoints.e2e.spec.ts`. That splits
      // one package across two builds, which is tolerable here for the same reason patch drift between
      // members is: both sit on the 22.0 line.
      'mfe11|@angular/platform-browser@22.0.6',
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/platform-browser']).toBe(
      'http://mfe2/_angular_platform_browser.djzJcPG8PR.js'
    );
    expect(map.imports['@angular/platform-browser/animations']).toContain('http://mfe11/');
  });

  test('keeps a strictly pinned remote deduped when the pin actually fits', async ({ nf }) => {
    // `mfe9` declares `~22.0.5` and ships no router at all, which looks like the split-family
    // trigger — but `~22.0.5` accepts every 22.0.x from 22.0.5 up, so the shared 22.0.6/22.0.8 build
    // satisfies it and the builds it draws on sit on one minor line. It dedups, and the portfolio is
    // byte-identical to the captured seven. The trigger needs a *minor* gap, not a strict pin.
    await run(nf, [...CAPTURED_SEVEN, 'mfe9'], { namespace: 'pin' });
    const withPin = await sharedTags(nf, 'pin');
    expect(await nf.islands()).toEqual(['team/mfe1 on @angular/common@21.2.18']);

    await run(nf, CAPTURED_SEVEN, { namespace: 'base' });

    expect(withPin).toEqual(await sharedTags(nf, 'base'));
  });

  test('shares a cross-scope design system and an unscoped lockstep pair', async ({ nf }) => {
    // `mfe10` is the awkward one: its `@acme/design-system*` packages carry `pool: ng-core`,
    // which joins a different npm scope to the Angular family at a completely different version line
    // (4.2.0 beside 22.0.x); it pairs `react` + `react-dom` under `pool: react`, a family auto-pooling
    // can never group because the names are unscoped; and one of its entrypoints lives in a non-global
    // share scope. Nothing here conflicts, so nothing new islands — pools of unrelated version lines
    // are not a coherence problem by themselves.
    await run(nf, [...CAPTURED_SEVEN, 'mfe10']);

    expect(await nf.islands()).toEqual(['team/mfe1 on @angular/common@21.2.18']);
    const tags = await sharedTags(nf);
    expect(tags['react']).toBe('18.3.1');
    expect(tags['react-dom']).toBe('18.3.1');
    expect(tags['@acme/design-system']).toBe('4.2.0');
    expect(await splitPackages(nf)).toEqual({});

    // The lockstep pair really is one build, and the entrypoint in the `team-a` share scope resolves
    // from inside that remote — a scope-only mapping no global import covers.
    const loaded = await nf.loadAll();
    expect(loaded['team/mfe10']!.seen['react']).toBe('mfe10|react@18.3.1');
    expect(loaded['team/mfe10']!.seen['react-dom']).toBe('mfe10|react-dom@18.3.1');
    expect(loaded['team/mfe10']!.seen['@acme/design-system/icons']).toBe(
      'mfe10|@acme/design-system/icons@4.2.0'
    );
    expect(await nf.resolve('@acme/design-system/icons', 'http://mfe1/')).toContain('UNRESOLVED');
  });

  test('holds the whole eleven-remote portfolio coherent', async ({ nf }) => {
    await run(nf, [...CAPTURED_SEVEN, 'mfe8', 'mfe9', 'mfe10', 'mfe11']);

    // Two islands, both cross-major; every remaining shared Angular external on one major; no package
    // split across tags anywhere.
    expect(await nf.islands()).toEqual([
      'team/mfe1 on @angular/common@21.2.18',
      'team/mfe8 on @angular/common@21.2.15',
    ]);
    expect(new Set(Object.values(await angularTags(nf)))).toEqual(new Set(['22.0.8', '22.0.6']));
    expect(await splitPackages(nf)).toEqual({});

    // Eleven remotes, ~50 shared externals, every declared entrypoint resolvable, and no remote left
    // holding two Angular minor lines.
    const loaded = await nf.loadAll();
    expect(Object.keys(loaded)).toHaveLength(11);
    for (const [name, lines] of Object.entries(angularLinesPerRemote(loaded)))
      expect(lines, `${name} draws from more than one Angular minor line`).toHaveLength(1);
  });
});
