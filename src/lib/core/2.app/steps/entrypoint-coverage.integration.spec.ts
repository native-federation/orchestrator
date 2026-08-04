import { createProcessRemoteEntries } from './process-remote-entries';
import { createDetermineSharedExternals } from './determine-shared-externals';
import { createGenerateImportMap } from './generate-import-map';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { Optional } from 'lib/utils/optional';
import {
  GLOBAL_SCOPE,
  type ImportMap,
  type RemoteInfo,
  type SharedExternal,
  type SharedVersionMeta,
} from 'lib/core/1.domain';
import type { LoggingConfig } from '../config/log.contract';
import type { ModeConfig } from '../config/mode.contract';
import type { DrivingContract } from '../driving-ports/driving.contract';

// Real-world regression (issue #61): three remotes share `@angular/material@22.0.6` but only
// `@par-ticle/mutations` bundles the `/sort` entrypoint.
const MATERIAL = '@angular/material';
const DI = '@par-ticle-settings/digitaal-inschrijven';
const PP = '@par-ticle-settings/parro-portaal';
const MU = '@par-ticle/mutations';

const REMOTES: { name: string; entries: Record<string, string> }[] = [
  { name: DI, entries: { '@angular/material/table': 'table-DI.js' } },
  { name: PP, entries: { '@angular/material/table': 'table-PP.js' } },
  {
    name: MU,
    entries: { '@angular/material/sort': 'sort-MU.js', '@angular/material/table': 'table-MU.js' },
  },
];

describe('entrypoint coverage (integration)', () => {
  let config: LoggingConfig & ModeConfig;
  let adapters: DrivingContract;
  let stored: SharedExternal | undefined;

  const run = async (remotes = REMOTES): Promise<{ basis: string; map: ImportMap }> => {
    await createProcessRemoteEntries(
      config,
      adapters
    )(
      remotes.map(r => ({
        name: r.name,
        url: `http://feed/${r.name}/remoteEntry.json`,
        exposes: [],
        host: false,
        shared: [
          {
            packageName: MATERIAL,
            singleton: true,
            strictVersion: true,
            version: '22.0.6',
            requiredVersion: '~22.0.6',
            entries: r.entries,
          },
        ],
      })) as never
    );

    await createDetermineSharedExternals(config, adapters)();

    const map = await createGenerateImportMap(config, adapters)();
    return { basis: stored!.versions[0]!.remotes[0]!.name, map };
  };

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    stored = undefined;

    adapters.versionCheck.isValidSemver = vi.fn(() => true);
    adapters.versionCheck.compare = vi.fn(() => 0);
    adapters.versionCheck.isCompatible = vi.fn(() => true);

    adapters.sharedExternalsRepo.tryGet = vi.fn(() =>
      stored ? Optional.of(stored) : Optional.empty<SharedExternal>()
    );
    adapters.sharedExternalsRepo.addOrUpdate = vi.fn((_name: string, external: SharedExternal) => {
      stored = external;
      return adapters.sharedExternalsRepo;
    });
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({ [MATERIAL]: stored! }));
    adapters.sharedExternalsRepo.getScopes = vi.fn((opt?: { includeGlobal?: boolean }) =>
      opt?.includeGlobal === false ? [] : [GLOBAL_SCOPE]
    );

    adapters.remoteInfoRepo.getAll = vi.fn(() => ({}));
    adapters.scopedExternalsRepo.getAll = vi.fn(() => ({}));
    adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
      Optional.of({ scopeUrl: `http://feed/${name}/`, exposes: [] } as unknown as RemoteInfo)
    );
  });

  it('should choose the widest remote as basis and serve every entrypoint from it', async () => {
    const { basis, map } = await run();

    expect(basis).toBe(MU);
    expect(map.imports).toEqual({
      '@angular/material/sort': `http://feed/${MU}/sort-MU.js`,
      '@angular/material/table': `http://feed/${MU}/table-MU.js`,
    });
  });

  it('should not tear the package across builds regardless of remote arrival order', async () => {
    const { basis, map } = await run([REMOTES[2]!, REMOTES[0]!, REMOTES[1]!]);

    expect(basis).toBe(MU);
    expect(map.imports).toEqual({
      '@angular/material/sort': `http://feed/${MU}/sort-MU.js`,
      '@angular/material/table': `http://feed/${MU}/table-MU.js`,
    });
  });

  it('should self-fill from a sibling when no single remote covers everything', async () => {
    const { map } = await run([
      {
        name: DI,
        entries: {
          '@angular/material/table': 'table-DI.js',
          '@angular/material/sort': 'sort-DI.js',
        },
      },
      {
        name: MU,
        entries: {
          '@angular/material/table': 'table-MU.js',
          '@angular/material/paginator': 'pag-MU.js',
        },
      },
    ]);

    expect(map.imports).toEqual({
      '@angular/material/table': `http://feed/${DI}/table-DI.js`,
      '@angular/material/sort': `http://feed/${DI}/sort-DI.js`,
      '@angular/material/paginator': `http://feed/${MU}/pag-MU.js`,
    });
  });

  // A remote added to a manifest whose version is already cached and resolved: the tag list does
  // not change, so `dirty` used to stay false and the cached actions were never revisited.
  describe('a remote joining an already-resolved version', () => {
    const cachedRemote = (
      name: string,
      entries: Record<string, string>,
      overrides: Partial<SharedVersionMeta> = {}
    ): SharedVersionMeta => ({
      name,
      requiredVersion: '~22.0.6',
      strictVersion: true,
      cached: true,
      entries,
      ...overrides,
    });

    const warmCache = (versions: SharedExternal['versions']): void => {
      stored = { dirty: false, versions };
    };

    const servedByDI = () =>
      warmCache([
        {
          tag: '22.0.6',
          host: false,
          action: 'share',
          remotes: [cachedRemote(DI, { '@angular/material/table': 'table-DI.js' })],
        },
      ]);

    // The joining remote builds the tag that is already shared, so the two copies merge and the
    // union of their entrypoints is exposed — the coverage policy only governs other versions.
    it('should merge the joining remote into the cached version under scopeUncoveredEntrypoints', async () => {
      config.profile.scopeUncoveredEntrypoints = true;
      servedByDI();

      const { map } = await run([REMOTES[2]!]);

      expect(stored!.versions.map(v => [v.tag, v.action, v.remotes.map(r => r.name)])).toEqual([
        ['22.0.6', 'share', [DI, MU]],
      ]);
      expect(map.imports).toEqual({
        '@angular/material/table': `http://feed/${DI}/table-DI.js`,
        '@angular/material/sort': `http://feed/${MU}/sort-MU.js`,
      });
    });

    it('should merge the joining remote under strictEntryPointCoverage', async () => {
      config.strict.strictEntryPointCoverage = true;
      servedByDI();

      const { map } = await run([REMOTES[2]!]);

      expect(map.imports).toEqual({
        '@angular/material/table': `http://feed/${DI}/table-DI.js`,
        '@angular/material/sort': `http://feed/${MU}/sort-MU.js`,
      });
    });

    it('should self-fill the joining remote by default', async () => {
      servedByDI();

      const { map } = await run([REMOTES[2]!]);

      expect(map.imports).toEqual({
        '@angular/material/table': `http://feed/${DI}/table-DI.js`,
        '@angular/material/sort': `http://feed/${MU}/sort-MU.js`,
      });
    });

    it('should re-resolve compatibility when a strict remote joins a skipped version', async () => {
      adapters.versionCheck.isCompatible = vi.fn(
        (tag: string, range: string) => range === `~${tag}`
      );
      warmCache([
        {
          tag: '22.0.6',
          host: false,
          action: 'share',
          remotes: [cachedRemote(DI, { '@angular/material/table': 'table-DI.js' })],
        },
        {
          tag: '22.0.5',
          host: false,
          action: 'skip',
          remotes: [
            cachedRemote(PP, { '@angular/material/table': 'table-PP.js' }, {
              requiredVersion: '~22.0.5',
              strictVersion: false,
              cached: false,
            }),
          ],
        },
      ]);

      await createProcessRemoteEntries(
        config,
        adapters
      )([
        {
          name: MU,
          url: `http://feed/${MU}/remoteEntry.json`,
          exposes: [],
          host: false,
          shared: [
            {
              packageName: MATERIAL,
              singleton: true,
              strictVersion: true,
              version: '22.0.5',
              requiredVersion: '~22.0.5',
              entries: { '@angular/material/table': 'table-MU.js' },
            },
          ],
        },
      ] as never);
      await createDetermineSharedExternals(config, adapters)();

      // MU pins ~22.0.5, so 22.0.6 can no longer be the shared copy and DI keeps its own build.
      expect(stored!.versions.map(v => [v.tag, v.action])).toEqual([
        ['22.0.6', 'scope'],
        ['22.0.5', 'share'],
      ]);
    });
  });
});
