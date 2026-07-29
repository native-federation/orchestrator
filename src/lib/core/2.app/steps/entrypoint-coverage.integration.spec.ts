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
});
