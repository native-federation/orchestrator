import { createInitRemoteEntryFlow } from './init-remote-entry.flow';
import { createInitDrivers } from 'lib/core/5.di/init.factory';
import { createChunkRepository } from 'lib/core/3.adapters/storage/chunk.repository';
import { createRemoteInfoRepository } from 'lib/core/3.adapters/storage/remote-info.repository';
import { createScopedExternalsRepository } from 'lib/core/3.adapters/storage/scoped-externals.repository';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { createStorageHandlerMock } from 'lib/testing/handlers/storage.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockConfig } from 'lib/testing/config.mock';
import { NFError } from 'lib/core/native-federation.error';
import type { ConfigContract } from '../config/config.contract';
import type { DrivingContract } from '../driving-ports/driving.contract';
import type { InitDriversContract } from '../driver-ports/init/drivers.contract';
import type { InitRemoteEntryFlow, RemoteRef } from '../driver-ports/init/flow.contract';
import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';

// A dynamic load that fails must leave the page as if it never ran, against the real repositories: they
// live for the whole page, so a half-written failure is what the next load commits, and a remote info
// written before the failure makes a retry by name skip the fetch. The exported flow runs bare, with no
// createFederationResult around it: the rollback is the flow's own.

const shared = (
  packageName: string,
  version: string | undefined,
  requiredVersion: string,
  o: Partial<DenseSharedInfo> = {}
): DenseSharedInfo =>
  ({
    packageName,
    version,
    requiredVersion,
    singleton: true,
    strictVersion: true,
    entries: { [packageName]: `${packageName}-${version}.js` },
    ...o,
  }) as DenseSharedInfo;

const entry = (name: string, deps: DenseSharedInfo[], o: Partial<RemoteEntry> = {}): RemoteEntry =>
  ({
    name,
    url: `http://${name}/remoteEntry.json`,
    exposes: [{ key: './Cmp', outFileName: 'cmp.js' }],
    shared: deps,
    ...o,
  }) as unknown as RemoteEntry;

// r1 accepts the shared 'a' but refuses 'b': '^2.0.0' with strictVersion cannot take the shared 1.0.0.
const refused = () =>
  entry('r1', [shared('a', '1.0.0', '^1.0.0'), shared('b', '2.0.0', '^2.0.0')], {
    chunks: { 'browser-shared': ['chunk-r1.js'] },
  });
const corrected = () =>
  entry('r1', [shared('a', '1.0.0', '^1.0.0'), shared('b', '1.0.0', '^1.0.0')], {
    chunks: { 'browser-shared': ['chunk-r1.js'] },
  });

// Every refusal sits on the last external, after one that joins a shared version, one that adds a new
// external and a scoped one, so each kind of write has had its chance to land.
const refusedOn = (last: DenseSharedInfo) => () =>
  entry(
    'r1',
    [
      shared('a', '1.0.0', '^1.0.0'),
      shared('d', '1.0.0', '^1.0.0'),
      shared('e', '1.0.0', '^1.0.0', { singleton: false }),
      last,
    ],
    { chunks: { 'browser-shared': ['chunk-r1.js'] } }
  );

describe('init-remote-entry flow: a failed load', () => {
  let storageRef: Record<string, unknown>;
  let config: ConfigContract;
  let adapters: DrivingContract;
  let drivers: InitDriversContract;
  let initRemoteEntry: InitRemoteEntryFlow;
  let served: Record<string, () => RemoteEntry>;

  beforeEach(async () => {
    storageRef = {};
    const storage = { storage: createStorageHandlerMock(storageRef), clearStorage: false };

    config = mockConfig();
    config.strict.strictExternalCompatibility = true;
    config.profile.overrideCachedRemotes = 'init-only';

    adapters = {
      ...mockAdapters(),
      remoteInfoRepo: createRemoteInfoRepository(storage),
      scopedExternalsRepo: createScopedExternalsRepository(storage),
      sharedExternalsRepo: createSharedExternalsRepository(storage),
      sharedChunksRepo: createChunkRepository(storage),
      versionCheck: createVersionCheck(),
    };
    served = {};
    adapters.remoteEntryProvider.provide = vi.fn((url: string) => Promise.resolve(served[url]!()));

    drivers = createInitDrivers({ config, adapters });
    initRemoteEntry = createInitRemoteEntryFlow({ flow: drivers, adapters, config });

    // What init.flow runs, from the fetched entries on.
    await drivers
      .processRemoteEntries([
        entry(
          'r0',
          [
            shared('a', '1.0.0', '^1.0.0'),
            shared('b', '1.0.0', '^1.0.0'),
            shared('c', '1.0.0', '^1.0.0'),
          ],
          { chunks: { 'browser-shared': ['chunk-r0.js'] } }
        ),
      ])
      .then(drivers.poolSharedExternals)
      .then(drivers.determineSharedExternals)
      .then(drivers.generateImportMap)
      .then(importMap => drivers.commitChanges(importMap, { override: true }));
  });

  const snapshot = () =>
    structuredClone({
      shared: adapters.sharedExternalsRepo.getFromScope(undefined),
      remotes: adapters.remoteInfoRepo.getAll(),
      scoped: adapters.scopedExternalsRepo.getAll(),
      chunks: ['r0', 'r1'].map(r => adapters.sharedChunksRepo.tryGet(r, 'browser-shared').get()),
    });
  const stored = () => structuredClone(storageRef);

  it.each([
    {
      name: 'an incompatible version (strictExternalCompatibility)',
      flag: 'strictExternalCompatibility',
      last: shared('b', '2.0.0', '^2.0.0'),
    },
    {
      name: 'a mismatched range on the same version (strictExternalSameVersionCompatibility)',
      flag: 'strictExternalSameVersionCompatibility',
      last: shared('b', '1.0.0', '~1.0.0'),
    },
    {
      name: 'an invalid version (strictExternalVersion)',
      flag: 'strictExternalVersion',
      last: shared('b', undefined, '^1.0.0'),
    },
  ] as const)('leaves every repository untouched when refusing $name', async ({ flag, last }) => {
    config.strict[flag] = true;
    const before = snapshot();
    served['http://r1/remoteEntry.json'] = refusedOn(last);

    await expect(initRemoteEntry('http://r1/remoteEntry.json', 'r1')).rejects.toThrow(
      "Could not process remote 'r1'"
    );

    expect(snapshot()).toEqual(before);
  });

  it('lets a following successful load commit nothing of the refused remote', async () => {
    served['http://r1/remoteEntry.json'] = refused;
    served['http://r2/remoteEntry.json'] = () =>
      entry('r2', [shared('a', '1.0.0', '^1.0.0'), shared('b', '1.0.0', '^1.0.0')]);

    await expect(initRemoteEntry('http://r1/remoteEntry.json', 'r1')).rejects.toThrow();
    await initRemoteEntry('http://r2/remoteEntry.json', 'r2');

    const committed = JSON.stringify(storageRef);
    expect(committed).toContain('"r2"');
    expect(committed).not.toContain('r1');
    expect(
      adapters.sharedExternalsRepo
        .tryGet('a')
        .get()!
        .versions.flatMap(v => v.remotes.map(r => r.name))
    ).toEqual(['r0', 'r2']);
  });

  it('fetches and loads the remote again when it is retried by name', async () => {
    served['http://r1/remoteEntry.json'] = refused;
    await expect(initRemoteEntry('http://r1/remoteEntry.json', 'r1')).rejects.toThrow();

    served['http://r1/remoteEntry.json'] = corrected;
    await initRemoteEntry('http://r1/remoteEntry.json', 'r1');

    expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledTimes(2);
    expect(adapters.remoteInfoRepo.tryGetModule('r1', './Cmp').get()).toBe('http://r1/cmp.js');
    expect(
      adapters.sharedExternalsRepo
        .tryGet('b')
        .get()!
        .versions.flatMap(v => v.remotes.map(r => r.name))
    ).toEqual(['r0', 'r1']);
  });

  // update-cache has written every external and the remote info by the time the import map is built. No
  // remote entry reaches the converter's own strictImportMap throw today, so the converter is made to throw.
  it('leaves the repositories untouched when building the import map throws after update-cache wrote', async () => {
    config.strict.strictImportMap = true;
    vi.mocked(adapters.browser.setImportMapFn).mockClear();
    const before = snapshot();
    const persisted = stored();
    initRemoteEntry = createInitRemoteEntryFlow({
      flow: {
        ...drivers,
        convertToImportMap: () => Promise.reject(new NFError('Could not create ImportMap.')),
      },
      adapters,
      config,
    });
    served['http://r1/remoteEntry.json'] = corrected;

    await expect(initRemoteEntry('http://r1/remoteEntry.json', 'r1')).rejects.toThrow(
      'Could not create ImportMap.'
    );

    expect(snapshot()).toEqual(before);
    expect(stored()).toEqual(persisted);
    expect(adapters.browser.setImportMapFn).not.toHaveBeenCalled();
  });

  // r2 keeps 'b' shared at 1.0.0 once r0's previous copy is evicted, so the reload's 2.0.0 is still refused.
  it('keeps the previous copy of a remote when an overriding reload is refused', async () => {
    served['http://r2/remoteEntry.json'] = () =>
      entry('r2', [shared('a', '1.0.0', '^1.0.0'), shared('b', '1.0.0', '^1.0.0')]);
    await initRemoteEntry('http://r2/remoteEntry.json', 'r2');
    config.profile.overrideCachedRemotes = 'always';
    const before = snapshot();
    served['http://r0-v2/remoteEntry.json'] = () =>
      entry('r0', [shared('a', '1.0.0', '^1.0.0'), shared('b', '2.0.0', '^2.0.0')], {
        url: 'http://r0-v2/remoteEntry.json',
      });

    await expect(initRemoteEntry('http://r0-v2/remoteEntry.json', 'r0')).rejects.toThrow(
      "Could not process remote 'r0'"
    );

    expect(snapshot()).toEqual(before);
    expect(adapters.remoteInfoRepo.tryGet('r0').get()!.scopeUrl).toBe('http://r0/');
  });

  it("hands beforeRollback the failed load's records, then rolls them back", async () => {
    const hook = vi.fn((_url: string, _remote?: RemoteRef) => snapshot());
    const before = snapshot();
    initRemoteEntry = createInitRemoteEntryFlow({
      flow: drivers,
      adapters,
      config,
      beforeRollback: hook,
    });
    served['http://r1/remoteEntry.json'] = refused;

    await expect(initRemoteEntry('http://r1/remoteEntry.json', 'r1')).rejects.toThrow();

    expect(hook).toHaveBeenCalledExactlyOnceWith('http://r1/remoteEntry.json', 'r1');
    expect(hook.mock.results[0]!.value.remotes['r1']).toBeDefined();
    expect(snapshot()).toEqual(before);
  });

  it('never calls beforeRollback when the load succeeds', async () => {
    const hook = vi.fn();
    initRemoteEntry = createInitRemoteEntryFlow({
      flow: drivers,
      adapters,
      config,
      beforeRollback: hook,
    });
    served['http://r1/remoteEntry.json'] = corrected;

    await initRemoteEntry('http://r1/remoteEntry.json', 'r1');

    expect(hook).not.toHaveBeenCalled();
    expect(adapters.remoteInfoRepo.contains('r1')).toBe(true);
  });

  it("rolls back and rejects with the load's error when beforeRollback throws", async () => {
    const before = snapshot();
    initRemoteEntry = createInitRemoteEntryFlow({
      flow: drivers,
      adapters,
      config,
      beforeRollback: () => {
        throw new Error('hook failed');
      },
    });
    served['http://r1/remoteEntry.json'] = refused;

    await expect(initRemoteEntry('http://r1/remoteEntry.json', 'r1')).rejects.toThrow(
      "Could not process remote 'r1'"
    );

    expect(snapshot()).toEqual(before);
  });
});
