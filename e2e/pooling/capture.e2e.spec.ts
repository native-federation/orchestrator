import { test, expect, type Federation, type Loaded } from '../harness/federation';
import { fixture, CAPTURED_SEVEN, type FixtureName } from '../harness/portfolio';

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
 */

const run = (
  nf: Federation,
  names: FixtureName[],
  opts: { pooling?: boolean; namespace?: string } = {}
) => nf.init(names.map(fixture), { namespace: 'capture', ...opts });

/** The tag every still-shared external is served at, per share scope. */
const sharedTags = async (nf: Federation, namespace = 'capture') => {
  const tags: Record<string, string> = {};
  for (const [scope, externals] of Object.entries(await nf.store(namespace))) {
    for (const [name, external] of Object.entries(externals)) {
      const shared = external.versions.find(v => v.action === 'share');
      if (shared) tags[scope === '__GLOBAL__' ? name : `${scope}|${name}`] = shared.tag;
    }
  }
  return tags;
};

const angularTags = async (nf: Federation, namespace = 'capture') =>
  Object.fromEntries(
    Object.entries(await sharedTags(nf, namespace)).filter(([name]) => name.startsWith('@angular/'))
  );

/** The npm package a name belongs to: `@angular/core/primitives/di` → `@angular/core`. */
const rootOf = (name: string) =>
  name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]!;

/**
 * Externals belonging to one npm package (`@angular/core` and `@angular/core/primitives/di`) that ended
 * up shared at *different* tags. That is the runtime hazard in its purest form: two halves of one
 * package, compiled apart, both live in the same global scope.
 */
const splitPackages = async (nf: Federation, namespace = 'capture') => {
  const byPackage: Record<string, Set<string>> = {};
  for (const [key, tag] of Object.entries(await sharedTags(nf, namespace))) {
    const name = key.includes('|') ? key.split('|')[1]! : key;
    (byPackage[rootOf(name)] ??= new Set()).add(tag);
  }
  return Object.fromEntries(
    Object.entries(byPackage)
      .filter(([, tags]) => tags.size > 1)
      .map(([pkg, tags]) => [pkg, [...tags].sort()])
  );
};

/**
 * The same coherence question asked of the running page instead of the store: per remote, which minor
 * lines of `@angular/*` did its code actually end up holding? The agreement gate's promise is that this
 * is one line per remote — patch drift inside it is tolerated, a second line is the crash.
 */
const angularLinesPerRemote = (loaded: Record<string, Loaded>) =>
  Object.fromEntries(
    Object.entries(loaded).map(([name, { seen }]) => [
      name,
      [
        ...new Set(
          Object.values(seen)
            .map(id => /^(.+)\|(.+)@(.+)$/.exec(id))
            .filter((m): m is RegExpExecArray => !!m && m[2]!.startsWith('@angular/'))
            .map(m => m[3]!.split('.').slice(0, 2).join('.'))
        ),
      ].sort(),
    ])
  );

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
    expect(await nf.islands()).toEqual(['team/legacy-overview on @angular/common@21.2.18']);
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
      'team/legacy-overview': ['21.2'],
      'team/document-approval': ['22.0'],
      'team/settings-panel': ['22.0'],
      'team/settings-portal': ['22.0'],
      'team/data-mutations': ['22.0'],
      'team/tools': ['22.0'],
      'team/support-widget': ['22.0'],
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

    // And the island is scoped to the pool it was islanded from, not to the remote: legacy-overview
    // serves its own Angular family but still dedups `rxjs` from the modern majority, because rxjs is
    // unscoped and therefore in no pool with `@angular/*`.
    expect(loaded['team/legacy-overview']!.seen['rxjs']).toBe('settings-panel|rxjs@7.8.2');
    expect(loaded['team/legacy-overview']!.seen['@angular/core']).toBe(
      'legacy-overview|@angular/core@21.2.18'
    );
  });

  test('costs no extra downloads on this portfolio', async ({ nf }) => {
    // Coherence is not free in general, but here it is: the islanded remote swaps deduped copies for
    // its own, one for one. What changed is which files exist next to each other, not how many.
    await run(nf, CAPTURED_SEVEN, { namespace: 'pooled' });
    await nf.loadAll();
    const pooled = nf.downloads().length;

    await run(nf, CAPTURED_SEVEN, { pooling: false, namespace: 'unpooled' });
    await nf.loadAll();

    expect(nf.downloads()).toHaveLength(pooled);
  });
});

test.describe('capture: auto-pooling off leaves the remotes’ own tags to cover the family', () => {
  test('leaves the cross-major split in place for the untagged members', async ({ nf }) => {
    // Three of the seven remotes tag their Angular packages `pool: ng-core`; the cross-major remote
    // tags nothing. With auto-pooling off the family is therefore whatever those tags cover — so the
    // members only the cross-major remote provides stay outside it and stay globally shared at
    // 21.2.18, beside a shared 22.0.8 half of the same packages.
    //
    // This is the shape auto-pooling exists for: partial tagging silently leaves gaps, while grouping
    // on the npm scope covers the family whether or not every team remembered to tag it.
    await run(nf, CAPTURED_SEVEN, { pooling: false, namespace: 'partial' });

    expect(await splitPackages(nf, 'partial')).toEqual({
      '@angular/forms': ['21.2.18', '22.0.8'],
      '@angular/platform-browser': ['21.2.18', '22.0.8'],
    });

    const majors = new Set(
      Object.values(await angularTags(nf, 'partial')).map(tag => tag.split('.')[0])
    );
    expect(majors).toEqual(new Set(['21', '22']));

    // Where the damage is, precisely. On *this* portfolio every remote still resolves consistently:
    // both shared tags exist, but each remote declared the family itself, so each gets the tag its own
    // range elected — the 21 half is reachable only from the cross-major remote's scope.
    const loaded = await nf.loadAll();
    for (const lines of Object.values(angularLinesPerRemote(loaded))) expect(lines).toHaveLength(1);
    for (const specifier of ['@angular/core', '@angular/forms', '@angular/platform-browser'])
      expect(await nf.resolve(specifier, 'http://host.service/')).toContain('@22.0.8');

    // So the defect this portfolio exhibits is in the shared *set*, not yet in the running page: two
    // lines are published as shareable at once, and the next consumer to bind against the global entry
    // for one of them — host code, or a remote that does not declare the whole family — gets the mix.
    // The reachable version of that crash is pinned in `islands.e2e.spec.ts`, on a portfolio that has
    // a remote whose range accepts the wrong half.
  });
});

test.describe('capture: one more previous-major remote joins', () => {
  test('islands only the two cross-major remotes, not the modern majority', async ({ nf }) => {
    // The download objective's stress case. `legacy-widget` runs Angular 21.2.15 — a second, distinct
    // 21 patch tag — and conflicts with nobody the other remotes care about. When extra downloads were
    // counted per *version* rather than per remote copy, the two 21 versions outvoted the three modern
    // remotes that all agreed on 22.0.8: `@angular/router`'s winner moved to the 21 line, the modern
    // remotes' own copies became incompatible with it, and whole-family islanding spread that single
    // mis-election across five of eight remotes.
    //
    // Counting copies, both sides cost the same and the newest tag keeps it, so only the two remotes
    // that genuinely cannot use Angular 22 island.
    await run(nf, [...CAPTURED_SEVEN, 'legacy-widget']);

    expect(await nf.islands()).toEqual([
      'team/legacy-overview on @angular/common@21.2.18',
      'team/legacy-widget on @angular/common@21.2.15',
    ]);

    const scopedRemotes = Object.values(await nf.store('capture'))
      .flatMap(externals => Object.values(externals))
      .flatMap(external => external.versions.filter(v => v.action === 'scope'))
      .flatMap(v => v.remotes.map(r => r.name));
    expect([...new Set(scopedRemotes)].sort()).toEqual([
      'team/legacy-overview',
      'team/legacy-widget',
    ]);

    // The shared Angular set is untouched by their arrival.
    expect(new Set(Object.values(await angularTags(nf)))).toEqual(new Set(['22.0.8', '22.0.6']));
    expect(await splitPackages(nf)).toEqual({});

    // The two islands are on distinct patch tags, so each runs its own build rather than sharing one.
    const loaded = await nf.loadAll();
    expect(loaded['team/legacy-overview']!.seen['@angular/core']).toBe(
      'legacy-overview|@angular/core@21.2.18'
    );
    expect(loaded['team/legacy-widget']!.seen['@angular/core']).toBe(
      'legacy-widget|@angular/core@21.2.15'
    );
  });
});

test.describe('capture: the synthetic siblings', () => {
  test('keeps a consistent older superset remote fully deduped', async ({ nf }) => {
    // `shell` ships the widest Angular set of any remote, entirely from one 22.0.6 build, with loose
    // `^22.0.0` ranges. It can take the shared 22.0.8/22.0.6 build wholesale, so it must not island —
    // a family deduping down to one older-but-consistent build is exactly what sharing is for.
    await run(nf, [...CAPTURED_SEVEN, 'shell']);

    expect(await nf.islands()).toEqual(['team/legacy-overview on @angular/common@21.2.18']);
    expect(await splitPackages(nf)).toEqual({});

    // What it keeps of its own build is only what nobody else can serve, and it stays on one line.
    const loaded = await nf.loadAll();
    expect(angularLinesPerRemote(loaded)['team/shell']).toEqual(['22.0']);
    expect(
      [
        ...new Set(Object.values(loaded['team/shell']!.seen).filter(id => id.startsWith('shell|'))),
      ].sort()
    ).toEqual([
      // material, which shell solely provides...
      'shell|@angular/material@22.0.6',
      // ...and platform-browser's `/animations` entrypoints. The elected platform-browser build is
      // document-approval's 22.0.8, which declares only the root entrypoint, so the two it does not
      // cover are self-filled from shell — see `entrypoint-coverage.integration.spec.ts`. That splits
      // one package across two builds, which is tolerable here for the same reason patch drift between
      // members is: both sit on the 22.0 line.
      'shell|@angular/platform-browser@22.0.6',
    ]);

    const map = await nf.map();
    expect(map.imports['@angular/platform-browser']).toBe(
      'http://document-approval/_angular_platform_browser.djzJcPG8PR.js'
    );
    expect(map.imports['@angular/platform-browser/animations']).toContain('http://shell/');
  });

  test('keeps a strictly pinned remote deduped when the pin actually fits', async ({ nf }) => {
    // `strict-pin` declares `~22.0.5` and ships no router at all, which looks like the split-family
    // trigger — but `~22.0.5` accepts every 22.0.x from 22.0.5 up, so the shared 22.0.6/22.0.8 build
    // satisfies it and the builds it draws on sit on one minor line. It dedups, and the portfolio is
    // byte-identical to the captured seven. The trigger needs a *minor* gap, not a strict pin.
    await run(nf, [...CAPTURED_SEVEN, 'strict-pin'], { namespace: 'pin' });
    const withPin = await sharedTags(nf, 'pin');
    expect(await nf.islands()).toEqual(['team/legacy-overview on @angular/common@21.2.18']);

    await run(nf, CAPTURED_SEVEN, { namespace: 'base' });

    expect(withPin).toEqual(await sharedTags(nf, 'base'));
  });

  test('shares a cross-scope design system and an unscoped lockstep pair', async ({ nf }) => {
    // `design-system` is the awkward one: its `@acme/design-system*` packages carry `pool: ng-core`,
    // which joins a different npm scope to the Angular family at a completely different version line
    // (4.2.0 beside 22.0.x); it pairs `react` + `react-dom` under `pool: react`, a family auto-pooling
    // can never group because the names are unscoped; and one of its entrypoints lives in a non-global
    // share scope. Nothing here conflicts, so nothing new islands — pools of unrelated version lines
    // are not a coherence problem by themselves.
    await run(nf, [...CAPTURED_SEVEN, 'design-system']);

    expect(await nf.islands()).toEqual(['team/legacy-overview on @angular/common@21.2.18']);
    const tags = await sharedTags(nf);
    expect(tags['react']).toBe('18.3.1');
    expect(tags['react-dom']).toBe('18.3.1');
    expect(tags['@acme/design-system']).toBe('4.2.0');
    expect(await splitPackages(nf)).toEqual({});

    // The lockstep pair really is one build, and the entrypoint in the `team-a` share scope resolves
    // from inside that remote — a scope-only mapping no global import covers.
    const loaded = await nf.loadAll();
    expect(loaded['team/design-system']!.seen['react']).toBe('design-system|react@18.3.1');
    expect(loaded['team/design-system']!.seen['react-dom']).toBe('design-system|react-dom@18.3.1');
    expect(loaded['team/design-system']!.seen['@acme/design-system/icons']).toBe(
      'design-system|@acme/design-system/icons@4.2.0'
    );
    expect(await nf.resolve('@acme/design-system/icons', 'http://legacy-overview/')).toContain(
      'UNRESOLVED'
    );
  });

  test('holds the whole eleven-remote portfolio coherent', async ({ nf }) => {
    await run(nf, [...CAPTURED_SEVEN, 'legacy-widget', 'strict-pin', 'design-system', 'shell']);

    // Two islands, both cross-major; every remaining shared Angular external on one major; no package
    // split across tags anywhere.
    expect(await nf.islands()).toEqual([
      'team/legacy-overview on @angular/common@21.2.18',
      'team/legacy-widget on @angular/common@21.2.15',
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
