import { test, expect, storedActions } from '../harness/federation';
import { dep, remote, SCOPE } from '../harness/portfolio';

/**
 * What an incremental init may not do: resolve a pool off verdicts that describe an earlier portfolio.
 *
 * A `scope` verdict in storage has two possible authors — the resolver (a range violation) and pooling
 * itself (that is how an island is persisted). `determine` re-elects only *dirty* externals, and an
 * external is dirty only when a remote of its own merged, so a joiner that ships some members of a pool
 * and not others used to leave the rest carrying last run's pooling verdict — which gate 1 then read back
 * as an incompatibility. `spread-pool-dirtiness` closes that by re-electing a pool as a unit, so pooling
 * runs on a pool exactly when every member of it was re-elected.
 * See docs/version-resolver.md §"How pooling resolves".
 *
 * Every `nf.init` here is a real page load against the same `sessionStorage`.
 */
test.describe('incremental: a pool is re-elected as a unit', () => {
  // mfe1 ships the whole family; mfe2 pins `core` strictly one minor down; mfe3 joins later shipping
  // only `core`, at mfe1's tag. `router` is therefore never touched by the joiner.
  const whole = remote('team/mfe1', SCOPE.mfe1, [
    dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
    dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
  ]);
  const pinned = remote('team/mfe2', SCOPE.mfe2, [dep('@angular/core', '22.0.5', { req: '~22.0.5' })]);
  const coreOnly = remote('team/mfe3', SCOPE.mfe3, [
    dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
  ]);

  test('does not island a remote that is coherent in the new portfolio', async ({ nf }) => {
    await nf.init([whole, pinned]);
    await nf.init([whole, pinned, coreOnly]);

    // mfe1 wins `core` with its own build and ships the only `router`, so it is coherent here. It used
    // to stay islanded on the `router` verdict pooling wrote during the first init.
    expect(await nf.islands()).toEqual(['team/mfe2 on @angular/core@22.0.5']);

    // And `router` is still a shared member rather than a leftover scope with no provider.
    const store = await nf.store();
    expect(storedActions(store, '@angular/router')).toEqual(['22.1.0:share']);
    expect(storedActions(store, '@angular/core')).toEqual(['22.1.0:share', '22.0.5:scope']);
    expect((await nf.map()).imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
  });

  test('costs what the same portfolio costs cold', async ({ nf }) => {
    // The cost claim, measured rather than inferred: one copy of `router`, and two of `core` because
    // mfe2's pin genuinely cannot take the shared one.
    await nf.init([whole, pinned]);
    await nf.init([whole, pinned, coreOnly]);

    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(3);

    // No second build of the winning version on the page — the stale island used to put mfe1's own
    // core@22.1.0 beside the shared core@22.1.0.
    expect(await nf.buildsOf('@angular/core')).toEqual([
      'mfe1|@angular/core@22.1.0',
      'mfe2|@angular/core@22.0.5',
    ]);
  });

  test('keeps a pool resolvable when the joiner lands on the pinned tag', async ({ nf }) => {
    // The variant that used to collapse the pool completely: no member kept a shared version at all, so
    // the import map carried no framework entry and three remotes each downloaded their own copy.
    const joinsPinned = remote('team/mfe3', SCOPE.mfe3, [
      dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
    ]);
    await nf.init([whole, pinned]);
    await nf.init([whole, pinned, joinsPinned]);

    const store = await nf.store();
    expect(storedActions(store, '@angular/core')).toContain('22.1.0:share');
    expect(storedActions(store, '@angular/router')).toEqual(['22.1.0:share']);

    const map = await nf.map();
    expect(map.imports['@angular/core']).toBe('http://mfe1/@angular/core.js');
    expect(map.imports['@angular/router']).toBe('http://mfe1/@angular/router.js');
    expect(await nf.islands()).not.toContain('team/mfe1 on @angular/router@22.1.0');
  });

  test('reaches a fixed point: a third load re-decides nothing', async ({ nf }) => {
    await nf.init([whole, pinned]);
    await nf.init([whole, pinned, coreOnly]);
    const settled = await nf.map();

    await nf.init([whole, pinned, coreOnly]);

    expect(await nf.writes()).toEqual([]);
    expect(nf.fetches()).toEqual([]);
    expect(await nf.map()).toEqual(settled);
  });

  test('serves a dynamically loaded remote the family it would get cold', async ({ nf }) => {
    // The dynamic path does no election, so it can only read whatever the init path last wrote. A stale
    // island used to leave it drawing `core` from one build and `router` from its own — a split across a
    // minor line, with nothing logged.
    const dynamic = remote('team/mfe4', SCOPE.mfe4, [
      dep('@angular/core', '22.0.5', { req: '^22.0.0' }),
      dep('@angular/router', '22.0.5', { req: '^22.0.0' }),
    ]);
    await nf.init([whole, pinned], { unlisted: [dynamic] });
    await nf.init([whole, pinned, coreOnly], { unlisted: [dynamic] });

    await nf.initRemoteEntry(dynamic.url);

    expect((await nf.load('team/mfe4')).seen).toEqual({
      '@angular/core': 'mfe1|@angular/core@22.1.0',
      '@angular/router': 'mfe1|@angular/router@22.1.0',
    });
  });
});

test.describe('incremental: a tag-formed pool on a warm cache', () => {
  // Auto-pooling off, so only the explicit `pool` tag groups these — and the tagged remotes are cached
  // by the second init, which is why `hasPoolTag()` has to read storage rather than this init's entries.
  const anchor = remote('team/mfe1', SCOPE.mfe1, [
    dep('core-pkg', '22.1.0', { req: '^22.0.0', pool: 'fw' }),
    dep('router-pkg', '22.1.0', { req: '^22.0.0', pool: 'fw' }),
  ]);
  const pinned = remote('team/mfe2', SCOPE.mfe2, [
    dep('core-pkg', '22.0.5', { req: '~22.0.5', pool: 'fw' }),
  ]);
  // Declares no tag of its own and touches only one member of the pool.
  const untagged = remote('team/mfe3', SCOPE.mfe3, [dep('core-pkg', '22.1.0', { req: '^22.0.0' })]);

  test('still coordinates the pool when no fetched entry declares the tag', async ({ nf }) => {
    await nf.init([anchor, pinned], { pooling: false });
    await nf.init([anchor, pinned, untagged], { pooling: false });

    expect(nf.fetches()).toEqual([untagged.url]);

    const store = await nf.store();
    expect(storedActions(store, 'router-pkg')).toEqual(['22.1.0:share']);
    expect(await nf.islands()).toEqual(['team/mfe2 on core-pkg@22.0.5']);

    await nf.loadAll();
    expect(nf.downloads()).toHaveLength(3);
  });
});

test.describe('incremental: the stored version order survives pooling', () => {
  // `commit()` guarantees versions are semver-descending and `determine` reads `versions[0]` as "the
  // latest" for `profile.latestSharedExternal`, keeping the FIRST candidate of equal cost. `commit()`
  // only re-sorts externals a *fetched* entry touched, so once a pool is re-elected off storage the
  // order pooling wrote is the order the election sees.
  test('rebuilds a member in descending tag order', async ({ nf }) => {
    const pinnedPair = remote('team/mfe1', SCOPE.mfe1, [
      dep('@angular/core', '22.0.5', { req: '~22.0.5' }),
      dep('@angular/router', '22.0.5', { req: '~22.0.5' }),
    ]);
    const midPair = remote('team/mfe2', SCOPE.mfe2, [
      dep('@angular/core', '22.1.0', { req: '^22.0.0' }),
      dep('@angular/router', '22.1.0', { req: '^22.0.0' }),
    ]);
    const crossMajor = remote('team/mfe3', SCOPE.mfe3, [
      dep('@angular/core', '23.0.0', { req: '^23.0.0' }),
    ]);

    await nf.init([pinnedPair, midPair, crossMajor]);

    // The winner here is an older tag than two of the stored versions, so grouping by action would
    // leave the list ascending.
    expect(storedActions(await nf.store(), '@angular/core')).toEqual([
      '23.0.0:scope',
      '22.1.0:skip',
      '22.0.5:share',
    ]);
  });
});
