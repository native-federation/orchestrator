import type { DenseSharedInfo, ImportMap, RemoteEntry, shareScope } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';

/**
 * Remotes loaded at runtime into a pooled page, through the real dynamic flow: a real init commits the
 * page, `runDynamic` loads a remote over it, and the harness checks no-tear and resolution on the committed
 * map plus the load's delta, the way a browser merges them.
 */
describe('pooling (dynamic)', () => {
  let p: ReturnType<typeof portfolio>;
  beforeEach(() => {
    p = portfolio({}, { storage: 'nf-pooling-dynamic', realRepositories: true });
  });

  const file = (remote: string, specifier: string) =>
    `http://${remote}/${specifier.slice(1).replace(/\//g, '_')}.js`;

  // One package of the `fw` pool unless `pool` says otherwise (`null`: unlabelled); `entrypoints` are its
  // secondary specifiers, shipped in the same build.
  const shared = (
    packageName: string,
    version: string,
    requiredVersion: string,
    o: { strict?: boolean; entrypoints?: string[]; pool?: string | null } = {}
  ): DenseSharedInfo =>
    ({
      packageName,
      version,
      requiredVersion,
      singleton: true,
      strictVersion: o.strict ?? true,
      ...(o.pool === null ? {} : { pool: o.pool ?? 'fw' }),
      entries: Object.fromEntries(
        [packageName, ...(o.entrypoints ?? [])].map(s => [
          s,
          `${s.slice(1).replace(/\//g, '_')}.js`,
        ])
      ),
    }) as DenseSharedInfo;

  const entry = (name: string, ...sharedInfo: DenseSharedInfo[]): RemoteEntry =>
    ({
      name,
      url: `http://${name}/remoteEntry.json`,
      exposes: [],
      shared: sharedInfo,
    }) as unknown as RemoteEntry;

  // What a remote resolves a specifier to: its own scope first, then `imports`, as the browser does.
  const resolves = (importMap: ImportMap, remote: string, specifier: string) =>
    importMap.scopes?.[`http://${remote}/`]?.[specifier] ?? importMap.imports[specifier];

  /**
   * Once the resolver scopes one member (a strict range rejects its committed tag), no committed build is
   * trusted with the remote: it serves its whole family itself, a member at the committed tag included, so
   * no file of the committed build can bind its modules (docs/version-resolver.md §"Scope and dynamic init").
   */
  describe('one rejected member scopes the whole family', () => {
    it('holds an unlabelled remote to a pool the committed remotes labelled', async () => {
      // One label anywhere is enough: mfe declares none, and could otherwise bridge two builds the page
      // pooled apart.
      await p.runInit([
        entry(
          'team-a',
          shared('@fw/core', '17.0.0', '^17.0.0'),
          shared('@fw/common', '17.0.0', '^17.0.0')
        ),
      ]);

      const { merged } = await p.runDynamic(
        entry(
          'mfe',
          shared('@fw/core', '17.0.0', '^17.0.0', { pool: null }),
          shared('@fw/common', '18.0.0', '^18.0.0', { pool: null })
        )
      );

      expect(p.islands()).toEqual({ mfe: 'incompatible' });
      expect(resolves(merged, 'mfe', '@fw/core')).toBe(file('mfe', '@fw/core'));
    });

    // mfe's ^21 rejects the committed 22.0.5, so the resolver scopes it and it serves its whole family; a
    // committed 21 island that fits it is no option, as a remote loaded at runtime joins no subpool.
    it('a remote whose range rejects the committed map serves its own family', async () => {
      await p.runInit([
        entry(
          'a',
          shared('@fw/core', '22.0.5', '^22.0.0'),
          shared('@fw/common', '22.0.5', '^22.0.0')
        ),
        entry(
          'legacy',
          shared('@fw/core', '21.2.0', '~21.2.0'),
          shared('@fw/common', '21.2.0', '~21.2.0')
        ),
      ]);

      await p.runDynamic(
        entry(
          'mfe',
          shared('@fw/core', '21.2.0', '^21.0.0'),
          shared('@fw/common', '21.2.0', '^21.0.0')
        )
      );

      expect(p.islands()).toEqual({ legacy: 'incompatible', mfe: 'incompatible' });
    });
  });
  /**
   * A load that ships an entrypoint the committed map lacks runs its whole family from its own build, in its own
   * scope: the committed `imports` never gain it. A later load on the same page inherits `imports`, so it must
   * not be told the map serves it; it runs the family itself too.
   */
  describe('a later load on the same page', () => {
    const fw = (version: string, core: string[]) => [
      shared('@fw/core', version, '^17.0.0', { entrypoints: core.filter(s => s !== '@fw/core') }),
      shared('@fw/common', version, '^17.0.0'),
    ];
    // The committed build ships `@fw/core/sub` and `@fw/common/sub` without either root.
    const entrypointOnly = (info: DenseSharedInfo): DenseSharedInfo => ({
      ...info,
      entries: {
        [`${info.packageName}/sub`]: info.entries[info.packageName]!.replace('.js', '_sub.js'),
      },
    });

    it('runs the family itself when an earlier load served an entrypoint into its own scope alone', async () => {
      await p.runInit([entry('a', ...fw('17.0.1', ['@fw/core']))]);
      await p.runDynamic(entry('l1', ...fw('17.0.1', ['@fw/core', '@fw/core/new'])));

      const { merged } = await p.runDynamic(
        entry('l2', ...fw('17.0.1', ['@fw/core', '@fw/core/new']))
      );

      expect(merged.scopes?.['http://l1/']?.['@fw/core/new']).toBe(file('l1', '@fw/core/new'));
      expect(merged.imports['@fw/core/new']).toBeUndefined();
      expect(resolves(merged, 'l2', '@fw/core/new')).toBe(file('l2', '@fw/core/new'));
      expect(resolves(merged, 'l2', '@fw/core')).toBe(file('l2', '@fw/core'));
      expect(p.islands()).toEqual({ l1: 'uncovered', l2: 'uncovered' });
    });

    // A shape a property run found: the host shares only secondary entrypoints, so a load that ships the roots
    // too runs the whole family from its own build, the host's secondary included.
    it('runs the family itself beside an entrypoint-only host', async () => {
      await p.runInit([entry('a', ...fw('17.0.1', ['@fw/core']).map(entrypointOnly))]);
      await p.runDynamic(entry('l1', ...fw('17.0.1', ['@fw/core', '@fw/core/sub'])));

      const { merged } = await p.runDynamic(
        entry('l2', ...fw('17.0.1', ['@fw/core', '@fw/core/sub']))
      );

      expect(resolves(merged, 'l2', '@fw/core')).toBe(file('l2', '@fw/core'));
      expect(resolves(merged, 'l2', '@fw/common')).toBe(file('l2', '@fw/common'));
      expect(resolves(merged, 'l2', '@fw/core/sub')).toBe(file('l2', '@fw/core/sub'));
    });

    // A named scope has no `imports` to inherit, but the rule is the same: the committed build lacks
    // `@fw/core/new`, so each load runs the family from its own build rather than an override naming two.
    it('runs the family of a named-scope load the map serves only in part from its own build', async () => {
      const team = (infos: DenseSharedInfo[]) => infos.map(i => ({ ...i, shareScope: 'team' }));
      const page = portfolio(
        {},
        { storage: 'nf-pooling-dynamic-team', realRepositories: true, scope: 'team' }
      );
      await page.runInit([entry('a', ...team(fw('17.0.1', ['@fw/core'])))]);
      await page.runDynamic(entry('l1', ...team(fw('17.0.1', ['@fw/core', '@fw/core/new']))));

      const { actions, merged } = await page.runDynamic(
        entry('l2', ...team(fw('17.0.2', ['@fw/core', '@fw/core/new'])))
      );

      expect(page.islands()).toEqual({ l1: 'uncovered', l2: 'uncovered' });
      expect(actions['@fw/core']).toEqual({ action: 'scope' });
      expect(resolves(merged, 'l2', '@fw/core')).toBe(file('l2', '@fw/core'));
      expect(resolves(merged, 'l2', '@fw/core/new')).toBe(file('l2', '@fw/core/new'));
    });
  });

  describe('a load at the committed tag', () => {
    const options = { realRepositories: true } as const;
    const fw = (entrypoints: string[] = []) => [
      shared('@fw/core', '17.0.0', '^17.0.0', { strict: false, entrypoints }),
      shared('@fw/common', '17.0.0', '^17.0.0', { strict: false }),
    ];
    const rowsOf = (record: shareScope, remote: string) =>
      Object.entries(record).flatMap(([name, external]) =>
        external.versions.flatMap(v =>
          v.remotes
            .filter(r => r.name === remote)
            .map(r => [name, v.tag, v.action, r.poolCause ?? null, r.servedBy ?? null])
        )
      );

    // mfe ships the committed 17.0.0 core plus a `/testing` the map lacks. The map serves the package only in
    // part, so the load runs mfe's whole `fw` family from its own build and leaves a0 on the committed one. The
    // load leaves its externals dirty, so the next warm init re-elects them and lands where a cold init does.
    it("runs a load's family from its own build when the map lacks an entrypoint at the committed tag", async () => {
      const committed = () => [entry('a0', ...fw())];
      const loaded = () => entry('mfe', ...fw(['@fw/core/testing']));
      const specifiers = ['@fw/core', '@fw/core/testing', '@fw/common'];
      const page = portfolio({}, { ...options, storage: 'nf-pooling-dynamic-same-tag' });
      await page.runInit(committed());

      const { actions, merged } = await page.runDynamic(loaded());

      expect(actions['@fw/core']).toEqual({ action: 'scope' });
      expect(actions['@fw/common']).toEqual({ action: 'scope' });
      expect(page.islands()).toEqual({ mfe: 'uncovered' });
      for (const specifier of specifiers)
        expect(resolves(merged, 'mfe', specifier)).toBe(file('mfe', specifier));
      expect(resolves(merged, 'a0', '@fw/core')).toBe(file('a0', '@fw/core'));
      expect(resolves(merged, 'a0', '@fw/common')).toBe(file('a0', '@fw/common'));

      page.reload();
      const warm = await page.runInit([...committed(), loaded()]);
      expect(page.islands()).toEqual({});
      expect(rowsOf(page.stored(), 'mfe')).toEqual([
        ['@fw/core', '17.0.0', 'share', null, null],
        ['@fw/common', '17.0.0', 'share', null, null],
      ]);
      for (const remote of ['a0', 'mfe'])
        for (const specifier of specifiers)
          expect(resolves(warm, remote, specifier)).toBe(file('mfe', specifier));
    });
  });

  /**
   * r0 and mfe ship identical builds of the family, so only the name tells them apart, and mfe sorts first.
   * A cold init of both hands the family to mfe. A load of mfe over a committed r0 cannot repoint the files the
   * page already runs, so it takes r0's; the warm inits after it keep them, as r0's copies are the cached ones,
   * and the second writes nothing. The page stays on r0 until its storage is cleared: a stable answer, not
   * the cold one.
   */
  describe('a load whose build ties the committed one exactly', () => {
    const fw = () => [
      shared('@fw/core', '17.0.0', '^17.0.0', { entrypoints: ['@fw/core/testing'] }),
      shared('@fw/common', '17.0.0', '^17.0.0'),
    ];
    const SPECIFIERS = ['@fw/core', '@fw/core/testing', '@fw/common'];

    it("keeps the committed build's files, where a cold init picks the build whose name sorts first", async () => {
      const page = portfolio({}, { realRepositories: true, storage: 'nf-pooling-dynamic-tie' });
      await page.runInit([entry('r0', ...fw())]);
      page.reload();

      const { merged } = await page.runDynamic(entry('mfe', ...fw()));
      for (const specifier of SPECIFIERS)
        expect(resolves(merged, 'mfe', specifier)).toBe(file('r0', specifier));

      // The load leaves its externals dirty, so the first warm init re-elects them; r0 keeps the pool.
      page.reload();
      const warm = await page.runInit([entry('r0', ...fw()), entry('mfe', ...fw())]);
      expect(page.stored()['@fw/core']!.poolWinner).toBe('r0');
      for (const specifier of SPECIFIERS) {
        expect(resolves(warm, 'mfe', specifier)).toBe(file('r0', specifier));
        expect(resolves(warm, 'r0', specifier)).toBe(file('r0', specifier));
      }
      page.reload();
      await page.runInit([entry('r0', ...fw()), entry('mfe', ...fw())]);
      expect(page.writes()).toBe(0);

      const cold = portfolio(
        {},
        { realRepositories: true, storage: 'nf-pooling-dynamic-tie-cold' }
      );
      const coldMap = await cold.runInit([entry('r0', ...fw()), entry('mfe', ...fw())]);
      for (const specifier of SPECIFIERS) {
        expect(resolves(coldMap, 'mfe', specifier)).toBe(file('mfe', specifier));
        expect(resolves(coldMap, 'r0', specifier)).toBe(file('mfe', specifier));
      }
    });
  });

  /**
   * The build a load opens a package with is the one the page then runs it from: the stored record names it
   * as the package's serving build, so the next page's map publishes that build's files again. A load that
   * follows the map, or runs a package from its own build, opens nothing and names nothing.
   */
  describe('a load that opens a package records its build as the serving build', () => {
    const open = (storage: string, o: { scope?: string } = {}) =>
      portfolio(
        {},
        { realRepositories: true, storage: `nf-pooling-dynamic-serving-${storage}`, ...o }
      );
    const servingBuilds = (p: ReturnType<typeof portfolio>, ...externals: string[]) =>
      externals.map(name => p.stored()[name]?.servingBuild);
    const common = () => shared('@fw/common', '17.0.0', '^17.0.0', { strict: false, pool: null });
    const core = (o: { entrypoints?: string[]; version?: string } = {}) =>
      shared('@fw/core', o.version ?? '17.0.0', `^${o.version ?? '17.0.0'}`, {
        strict: false,
        pool: null,
        entrypoints: o.entrypoints,
      });
    const testing = () =>
      shared('@fw/core/testing', '17.0.0', '^17.0.0', { strict: false, pool: null });

    it.each([
      ['dense', () => [core({ entrypoints: ['@fw/core/testing'] })], ['@fw/core']],
      ['flat', () => [core(), testing()], ['@fw/core', '@fw/core/testing']],
    ] as const)(
      'names the loader on every external of the package (%s)',
      async (_, ships, externals) => {
        const p = open(`opens-${_}`);
        await p.runInit([entry('host', common())]);

        await p.runDynamic(entry('mfe', ...ships()));

        expect(servingBuilds(p, ...externals)).toEqual(externals.map(() => 'mfe'));
      }
    );

    it("keeps it through a warm init, which serves the loader's files", async () => {
      const p = open('warm');
      await p.runInit([entry('host', common())]);
      await p.runDynamic(entry('mfe', core(), testing()));

      p.reload();
      const warm = await p.runInit([entry('host', common()), entry('mfe', core(), testing())]);

      expect(servingBuilds(p, '@fw/core', '@fw/core/testing')).toEqual(['mfe', 'mfe']);
      expect(warm.imports['@fw/core']).toBe(file('mfe', '@fw/core'));
      expect(warm.imports['@fw/core/testing']).toBe(file('mfe', '@fw/core/testing'));
    });

    it('keeps the first loader when a second load of the same build follows it', async () => {
      const p = open('second');
      await p.runInit([entry('host', common())]);
      await p.runDynamic(entry('l1', core()));

      const { actions } = await p.runDynamic(entry('l2', core()));

      expect(actions['@fw/core']).toMatchObject({ action: 'skip' });
      expect(servingBuilds(p, '@fw/core')).toEqual(['l1']);
    });

    it.each([
      ['follows the map', () => [core()], 'skip'],
      ['runs it from its own build', () => [core({ entrypoints: ['@fw/core/testing'] })], 'scope'],
    ] as const)('names nothing when the load %s', async (_, ships, action) => {
      const p = open(`none-${action}`);
      await p.runInit([entry('host', core())]);
      const before = servingBuilds(p, '@fw/core');

      const { actions } = await p.runDynamic(entry('mfe', ...ships()));

      expect(actions['@fw/core']).toMatchObject({ action });
      expect(servingBuilds(p, '@fw/core')).toEqual(before);
    });

    // mfe's strict core@18 rejects the host's 17, so its core runs from its own build while it opens forms, which
    // nobody shares; the gate then islands its whole fw family, forms included. The record must not keep naming
    // mfe as the serving build of a package it no longer shares.
    it('names nothing once the gate islands the family of a load that opened a package', async () => {
      const p = open('islanded');
      await p.runInit([entry('host', shared('@fw/core', '17.0.0', '^17.0.0'))]);

      await p.runDynamic(
        entry(
          'mfe',
          shared('@fw/core', '18.0.0', '^18.0.0'),
          shared('@fw/forms', '18.0.0', '^18.0.0')
        )
      );

      expect(p.islands()).toEqual({ mfe: 'incompatible' });
      expect(p.stored()['@fw/forms']!.versions.map(v => [v.tag, v.action])).toEqual([
        ['18.0.0', 'scope'],
      ]);
      expect(servingBuilds(p, '@fw/forms')).toEqual([undefined]);
    });

    it('names nothing in the strict scope, which serves every version side by side', async () => {
      const strict = (version: string) => ({ ...core({ version }), shareScope: 'strict' });
      const p = open('strict', { scope: 'strict' });
      await p.runInit([entry('host', strict('17.0.0'))]);

      await p.runDynamic(entry('mfe', strict('18.0.0')));

      expect(p.stored()['@fw/core']!.versions.map(v => [v.tag, v.action])).toEqual([
        ['18.0.0', 'share'],
        ['17.0.0', 'share'],
      ]);
      expect(servingBuilds(p, '@fw/core')).toEqual([undefined]);
    });
  });
});
