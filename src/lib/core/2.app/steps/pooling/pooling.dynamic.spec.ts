import type { DenseSharedInfo, ImportMap, RemoteEntry } from 'lib/core/1.domain';
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
   * A remote loaded at runtime may run a combination only one committed build shipped, and may take a
   * committed build only if that build covers every specifier it imports; no comparison of tags can stand
   * in for either. Two shapes: *disjoint providers* (each provides one member alone, no build ships the
   * pair the consumer would run) and *the lockstep pair* (two providers agree exactly on what they share,
   * yet the coupled pair is in neither build). On the flow, the witness rule already refuses those two
   * before coverage is asked; the last pair turns on coverage alone.
   */
  describe('coverage is what fails on the defect portfolios', () => {
    it('serves the consumer of two disjoint providers from its own build', async () => {
      // mfe1 provides core alone, mfe2 router alone at a newer minor; mfe3 consumes both at 22.0.5. The map
      // serves core from mfe1 and router from mfe2, a pair no build shipped, and neither covers mfe3.
      await p.runInit([
        entry('mfe1', shared('@fw/core', '22.0.5', '^22.0.0')),
        entry('mfe2', shared('@fw/router', '22.1.0', '^22.1.0')),
      ]);

      const { merged } = await p.runDynamic(
        entry(
          'mfe3',
          shared('@fw/core', '22.0.5', '^22.0.0'),
          shared('@fw/router', '22.0.5', '^22.0.0')
        )
      );

      expect(p.islands()).toEqual({ mfe3: 'uncovered' });
      expect(resolves(merged, 'mfe3', '@fw/core')).toBe(file('mfe3', '@fw/core'));
      expect(resolves(merged, 'mfe3', '@fw/router')).toBe(file('mfe3', '@fw/router'));
    });

    it('serves the consumer of a lockstep pair from its own build', async () => {
      // Both providers ship core@22.0.5 and agree on it exactly, so no tightening of a tag comparison
      // reaches this; but mfe1 lacks cdk and mfe2 lacks material, which mfe3 consumes together.
      await p.runInit([
        entry(
          'mfe1',
          shared('@fw/core', '22.0.5', '^22.0.0'),
          shared('@fw/material', '22.0.5', '^22.0.0')
        ),
        entry(
          'mfe2',
          shared('@fw/core', '22.0.5', '^22.0.0'),
          shared('@fw/cdk', '22.1.0', '^22.1.0')
        ),
      ]);

      await p.runDynamic(
        entry(
          'mfe3',
          shared('@fw/material', '22.0.5', '^22.0.0'),
          shared('@fw/cdk', '22.0.5', '^22.0.0')
        )
      );

      expect(p.islands()).toEqual({ mfe3: 'uncovered' });
    });

    describe('a specifier genuinely absent from the build', () => {
      // a's 22 build is global; legacy's 21 is a committed island. A 21 remote loaded non-strict is rejected
      // by the global map and looks for a committed build that covers it.
      const committed = (legacyEntrypoints: string[]) =>
        p.runInit([
          entry(
            'a',
            shared('@fw/core', '22.0.5', '^22.0.0', { entrypoints: ['@fw/core/testing'] }),
            shared('@fw/common', '22.0.5', '^22.0.0')
          ),
          entry(
            'legacy',
            shared('@fw/core', '21.2.0', '~21.2.0', { entrypoints: legacyEntrypoints }),
            shared('@fw/common', '21.2.0', '~21.2.0')
          ),
        ]);
      const mfe = entry(
        'mfe',
        shared('@fw/core', '21.2.0', '^21.0.0', {
          strict: false,
          entrypoints: ['@fw/core/testing'],
        }),
        shared('@fw/common', '21.2.0', '^21.0.0', { strict: false })
      );

      it('refuses the subpool of a build that lacks one specifier the remote imports', async () => {
        await committed([]);

        await p.runDynamic(mfe);

        expect(p.islands()).toEqual({ legacy: 'incompatible', mfe: 'incompatible' });
      });

      it('joins the same build once it ships that specifier too', async () => {
        await committed(['@fw/core/testing']);

        const { merged } = await p.runDynamic(mfe);

        expect(p.islands()).toEqual({ legacy: 'incompatible', mfe: 'subpool legacy' });
        expect(resolves(merged, 'mfe', '@fw/core/testing')).toBe(
          file('legacy', '@fw/core/testing')
        );
      });
    });
  });

  /**
   * Once the resolver scopes one member (a strict range rejects its committed tag), no committed build is
   * trusted with the remote: it serves its whole family itself, a member at the committed tag included, so
   * no file of the committed build can bind its modules (docs/version-resolver.md §"Scope and dynamic init").
   */
  describe('one rejected member scopes the whole family', () => {
    const family = ['@fw/core', '@fw/common', '@fw/cdk'];

    it('scopes every member, the ones at the committed tag included', async () => {
      await p.runInit([entry('host', ...family.map(s => shared(s, '17.0.0', '^17.0.0')))]);

      const { merged } = await p.runDynamic(
        entry(
          'mfe',
          shared('@fw/core', '17.0.0', '^17.0.0'),
          shared('@fw/common', '17.0.0', '^17.0.0'),
          shared('@fw/cdk', '18.0.0', '^18.0.0')
        )
      );

      expect(p.islands()).toEqual({ mfe: 'incompatible' });
      for (const specifier of family)
        expect(resolves(merged, 'mfe', specifier)).toBe(file('mfe', specifier));
    });

    it('bridges a package another pool labels into the family through the remote that labels it', async () => {
      // The host labels ui `ds`; mfe labels it `fw`, which joins ui to core's family for the whole page.
      await p.runInit([
        entry(
          'host',
          shared('@fw/core', '17.0.0', '^17.0.0'),
          shared('@ds/ui', '17.0.0', '^17.0.0', { pool: 'ds' }),
          shared('@ds/icons', '17.0.0', '^17.0.0', { pool: 'ds' })
        ),
      ]);

      const { merged } = await p.runDynamic(
        entry('mfe', shared('@fw/core', '17.0.0', '^17.0.0'), shared('@ds/ui', '18.0.0', '^18.0.0'))
      );

      expect(p.islands()).toEqual({ mfe: 'incompatible' });
      expect(resolves(merged, 'mfe', '@fw/core')).toBe(file('mfe', '@fw/core'));
    });

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

    // F4 (backlog): a committed 21 island would fit mfe as a subpool, but the resolver scoped mfe's core, so
    // it is not offered one and downloads a third 21 build. Pins today's behaviour; F4 flips it on purpose.
    it('offers no subpool to a remote the resolver scoped', async () => {
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
   * A subpool's build must offer every member at a tag the remote's own range accepts, not only cover it:
   * the flow form of `subpool-fit.spec.ts` "acceptance". Two committed 21 islands both cover mfe; legacy-a
   * sorts first but offers 21.1.0, which mfe's `~21.2.0` rejects, so mfe runs legacy-b's 21.2.0.
   */
  it('joins the island whose tags its range accepts, not the first one that covers it', async () => {
    const legacy = (name: string, tag: string, range: string) =>
      entry(name, shared('@fw/core', tag, range), shared('@fw/router', tag, range));
    await p.runInit([
      legacy('a', '22.0.5', '^22.0.0'),
      legacy('legacy-a', '21.1.0', '~21.1.0'),
      legacy('legacy-b', '21.2.0', '~21.2.0'),
    ]);
    expect(p.islands()).toEqual({ 'legacy-a': 'incompatible', 'legacy-b': 'incompatible' });

    // Non-strict, so the resolver leaves it to pooling.
    const { merged } = await p.runDynamic(
      entry(
        'mfe',
        shared('@fw/core', '21.2.5', '~21.2.0', { strict: false }),
        shared('@fw/router', '21.2.5', '~21.2.0', { strict: false })
      )
    );

    expect(p.islands()).toMatchObject({ mfe: 'subpool legacy-b' });
    for (const specifier of ['@fw/core', '@fw/router'])
      expect(resolves(merged, 'mfe', specifier)).toBe(file('legacy-b', specifier));
  });

  describe('sequential loads', () => {
    // a and b run the 22 family; legacy's ~21.2.0 rejects it, and alone it serves itself: no subpool yet.
    const remotes = [
      entry(
        'a',
        shared('@fw/core', '22.0.8', '^22.0.0'),
        shared('@fw/router', '22.0.8', '^22.0.0')
      ),
      entry(
        'b',
        shared('@fw/core', '22.0.8', '^22.0.0'),
        shared('@fw/router', '22.0.8', '^22.0.0')
      ),
      entry(
        'legacy',
        shared('@fw/core', '21.2.18', '~21.2.0'),
        shared('@fw/router', '21.2.18', '~21.2.0')
      ),
    ];
    // Two more 21 remotes, loaded at runtime. Non-strict, so the resolver leaves them to pooling.
    const legacyFamily = (name: string, tag: string) =>
      entry(
        name,
        shared('@fw/core', tag, '~21.2.0', { strict: false }),
        shared('@fw/router', tag, '~21.2.0', { strict: false })
      );
    const mfeD = legacyFamily('mfe-d', '21.2.18');
    const mfeE = legacyFamily('mfe-e', '21.2.15');

    // Every remote and specifier, and what each resolves to on one map.
    const page = (importMap: ImportMap) =>
      Object.fromEntries(
        [...remotes, mfeD, mfeE].flatMap(e =>
          e.shared.map(s => [
            `${e.name}|${s.packageName}`,
            resolves(importMap, e.name, s.packageName),
          ])
        )
      );

    it('lets a second load join the subpool the first load created', async () => {
      await p.runInit(remotes);
      expect(p.islands()).toEqual({ legacy: 'incompatible' });

      await p.runDynamic(mfeD);
      // The first load makes legacy's island a subpool: mfe-d runs legacy's build.
      expect(p.islands()).toEqual({ legacy: 'incompatible', 'mfe-d': 'subpool legacy' });

      const { merged } = await p.runDynamic(mfeE);
      expect(p.islands()).toEqual({
        legacy: 'incompatible',
        'mfe-d': 'subpool legacy',
        'mfe-e': 'subpool legacy',
      });
      // One 21 build for all three, mfe-e's own 21.2.15 never downloaded.
      for (const specifier of ['@fw/core', '@fw/router'])
        expect(resolves(merged, 'mfe-e', specifier)).toBe(file('legacy', specifier));

      // The next page runs the same files.
      p.reload();
      const warm = await p.runInit([...remotes, mfeD, mfeE]);
      expect(page(warm)).toEqual(page(merged));
    });
  });
});
