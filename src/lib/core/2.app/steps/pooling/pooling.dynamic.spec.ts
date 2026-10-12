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
   * A load that joins a committed share row at its tag serves the entrypoints the row lacks into its own scope
   * alone: the committed `imports` never gain them. A later load on the same page inherits `imports`, so it must
   * not be told the map serves them; it serves them itself.
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

    it('serves an entrypoint an earlier load served into its own scope alone', async () => {
      await p.runInit([entry('a', ...fw('17.0.1', ['@fw/core']))]);
      await p.runDynamic(entry('l1', ...fw('17.0.1', ['@fw/core', '@fw/core/new'])));

      const { merged } = await p.runDynamic(
        entry('l2', ...fw('17.0.1', ['@fw/core', '@fw/core/new']))
      );

      expect(merged.scopes?.['http://l1/']?.['@fw/core/new']).toBe(file('l1', '@fw/core/new'));
      expect(merged.imports['@fw/core/new']).toBeUndefined();
      expect(resolves(merged, 'l2', '@fw/core/new')).toBe(file('l2', '@fw/core/new'));
      expect(resolves(merged, 'l2', '@fw/core')).toBe(file('a', '@fw/core'));
    });

    // A shape a property run found: the host shares only secondary entrypoints, so the first
    // load to ship the roots serves them into its own scope.
    it('serves the roots an earlier load joined an entrypoint-only host with', async () => {
      await p.runInit([entry('a', ...fw('17.0.1', ['@fw/core']).map(entrypointOnly))]);
      await p.runDynamic(entry('l1', ...fw('17.0.1', ['@fw/core', '@fw/core/sub'])));

      const { merged } = await p.runDynamic(
        entry('l2', ...fw('17.0.1', ['@fw/core', '@fw/core/sub']))
      );

      expect(resolves(merged, 'l2', '@fw/core')).toBe(file('l2', '@fw/core'));
      expect(resolves(merged, 'l2', '@fw/common')).toBe(file('l2', '@fw/common'));
      expect(resolves(merged, 'l2', '@fw/core/sub')).toBe(file('a', '@fw/core/sub'));
    });

    // A named scope has no `imports` to inherit: the load's own scope gets an override, which may name the
    // earlier load's file, so a load at another tag still takes the map through a committed build's witness.
    it('points a named-scope load at the file an earlier load serves', async () => {
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

      expect(page.islands()).toEqual({});
      expect(actions['@fw/core']).toMatchObject({
        action: 'skip',
        override: { '@fw/core': file('a', '@fw/core'), '@fw/core/new': file('l1', '@fw/core/new') },
      });
      expect(resolves(merged, 'l2', '@fw/core/new')).toBe(file('l1', '@fw/core/new'));
    });
  });

  describe('under scopeUncoveredEntrypoints', () => {
    const options = { realRepositories: true, scopeUncoveredEntrypoints: true } as const;
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

    // jsdev-b-5's sameTagExtra, the nearest flow shape to a partly served resolver scope (which a coherent
    // committed map never produces): mfe ships the committed 17.0.0 core plus a `/testing` the map lacks.
    // Same-tag copies merge, so the resolver skips rather than scopes, and the load lands as a cold init of
    // the whole portfolio places mfe.
    it('places a load at the committed tag with an extra entrypoint as a cold init does', async () => {
      const committed = () => [entry('r0', ...fw())];
      const loaded = () => entry('mfe', ...fw(['@fw/core/testing']));
      const page = portfolio({}, { ...options, storage: 'nf-pooling-dynamic-same-tag' });
      await page.runInit(committed());

      const { actions, merged } = await page.runDynamic(loaded());

      const cold = portfolio({}, { ...options, storage: 'nf-pooling-dynamic-same-tag-cold' });
      const coldMap = await cold.runInit([...committed(), loaded()]);
      expect(actions['@fw/core']).toMatchObject({ action: 'skip', covered: ['@fw/core'] });
      expect(page.islands()).toEqual({});
      expect(cold.islands()).toEqual({});
      // mfe's copies join the share rows at the committed tag, as at a cold init.
      expect(rowsOf(page.stored(), 'mfe')).toEqual([
        ['@fw/core', '17.0.0', 'share', null, null],
        ['@fw/common', '17.0.0', 'share', null, null],
      ]);
      expect(rowsOf(page.stored(), 'mfe')).toEqual(rowsOf(cold.stored(), 'mfe'));
      for (const specifier of ['@fw/core', '@fw/core/testing', '@fw/common'])
        expect(resolves(merged, 'mfe', specifier)).toBe(resolves(coldMap, 'mfe', specifier));
    });
  });
});
