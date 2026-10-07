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

  // One package of the `fw` pool; `entrypoints` are its secondary specifiers, shipped in the same build.
  const shared = (
    packageName: string,
    version: string,
    requiredVersion: string,
    o: { strict?: boolean; entrypoints?: string[] } = {}
  ): DenseSharedInfo =>
    ({
      packageName,
      version,
      requiredVersion,
      singleton: true,
      strictVersion: o.strict ?? true,
      pool: 'fw',
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
   * in for either. Ported from `subpool-fit.spec.ts`, which checks the same portfolios against the gate's
   * helpers directly. On the flow, the witness rule already refuses the first two before coverage is
   * asked; the last pair turns on coverage alone.
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
