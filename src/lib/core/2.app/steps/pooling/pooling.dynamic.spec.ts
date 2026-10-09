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
});
