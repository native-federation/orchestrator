import { INIT_FLOW_FACTORY } from './init.factory';
import { createFederationResult } from './federation-result.factory';
import { createInitRemoteEntryFlow } from 'lib/core/2.app/flows/init-remote-entry.flow';
import { createRemoteInfoRepository } from 'lib/core/3.adapters/storage/remote-info.repository';
import { createScopedExternalsRepository } from 'lib/core/3.adapters/storage/scoped-externals.repository';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createChunkRepository } from 'lib/core/3.adapters/storage/chunk.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { createStorageHandlerMock } from 'lib/testing/handlers/storage.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockConfig } from 'lib/testing/config.mock';
import type { ConfigContract } from 'lib/core/2.app/config/config.contract';
import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';
import type { LoadRemoteModule } from 'lib/core/init-federation.contract';

const shared = (packageName: string, version: string, requiredVersion: string): DenseSharedInfo =>
  ({
    packageName,
    version,
    requiredVersion,
    singleton: true,
    strictVersion: true,
    entries: { [packageName]: `${packageName}-${version}.js` },
  }) as DenseSharedInfo;

const entry = (name: string, deps: DenseSharedInfo[]): RemoteEntry =>
  ({
    name,
    url: `http://${name}/remoteEntry.json`,
    exposes: [{ key: './Cmp', outFileName: 'cmp.js' }],
    shared: deps,
  }) as unknown as RemoteEntry;

// The wiring initFederation uses: the flow's beforeRollback, filled by INIT_FLOW_FACTORY, is the only debug
// state dump of a failed runtime load, and it runs before the rollback, so it shows what the load wrote.
describe('INIT_FLOW_FACTORY: a failed runtime load', () => {
  let config: ConfigContract;
  let adapters: DrivingContract;
  let storageRef: Record<string, unknown>;

  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    storageRef = {};
    const storage = { storage: createStorageHandlerMock(storageRef), clearStorage: false };
    config = mockConfig();
    config.strict.strictExternalCompatibility = true;
    adapters = {
      ...mockAdapters(),
      remoteInfoRepo: createRemoteInfoRepository(storage),
      scopedExternalsRepo: createScopedExternalsRepository(storage),
      sharedExternalsRepo: createSharedExternalsRepository(storage),
      sharedChunksRepo: createChunkRepository(storage),
      versionCheck: createVersionCheck(),
    };
    // r1 is refused on 'b': '^2.0.0' with strictVersion cannot take the shared 1.0.0, after 'a' was written.
    const served: Record<string, RemoteEntry> = {
      'http://r1/remoteEntry.json': entry('r1', [
        shared('a', '1.0.0', '^1.0.0'),
        shared('b', '2.0.0', '^2.0.0'),
      ]),
      'http://r2/remoteEntry.json': entry('r2', [shared('a', '1.0.0', '^1.0.0')]),
    };
    adapters.remoteEntryProvider.provide = vi.fn((url: string) => Promise.resolve(served[url]!));

    const { flow } = INIT_FLOW_FACTORY({ config, adapters });
    await flow
      .processRemoteEntries([
        entry('r0', [shared('a', '1.0.0', '^1.0.0'), shared('b', '1.0.0', '^1.0.0')]),
      ])
      .then(flow.poolSharedExternals)
      .then(flow.determineSharedExternals)
      .then(flow.generateImportMap)
      .then(importMap => flow.commitChanges(importMap, { override: true }));
  });

  it.each([
    { strictRemoteEntry: true, outcome: 'rejects' },
    { strictRemoteEntry: false, outcome: 'resolves' },
  ] as const)(
    'dumps the state the load left once, then rolls it back for the next load ($outcome under strictRemoteEntry: $strictRemoteEntry)',
    async ({ strictRemoteEntry }) => {
      config.strict.strictRemoteEntry = strictRemoteEntry;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = createFederationResult({
        config,
        adapters,
        loadRemoteModule: vi.fn() as unknown as LoadRemoteModule,
        initRemoteEntryFlow: createInitRemoteEntryFlow(INIT_FLOW_FACTORY({ config, adapters })),
      });
      const before = structuredClone(adapters.remoteInfoRepo.getAll());

      const loading = result.initRemoteEntry('http://r1/remoteEntry.json', 'r1');
      if (strictRemoteEntry) await expect(loading).rejects.toThrow("Could not process remote 'r1'");
      else await expect(loading).resolves.toBe(result);

      const dumps = vi
        .mocked(config.log.debug)
        .mock.calls.filter(([, msg]) => String(msg).includes('STATE DUMP'));
      expect(dumps).toHaveLength(1);
      expect(dumps[0]![1]).toBe('[dynamic-init][r1] STATE DUMP');
      expect((dumps[0]![2] as { remotes: Record<string, unknown> }).remotes['r1']).toBeDefined();
      expect(adapters.remoteInfoRepo.getAll()).toEqual(before);
      expect(adapters.sharedExternalsRepo.tryGet('a').get()!.versions[0]!.remotes).toHaveLength(1);

      await result.initRemoteEntry('http://r2/remoteEntry.json', 'r2');

      const committed = JSON.stringify(storageRef);
      expect(committed).toContain('"r2"');
      expect(committed).not.toContain('r1');
    }
  );
});
