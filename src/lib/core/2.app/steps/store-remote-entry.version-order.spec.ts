import type { DrivingContract } from '../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { Optional } from 'lib/utils/optional';
import type { DenseSharedInfo, RemoteEntry, RemoteInfo } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createProcessRemoteEntries } from './process-remote-entries';
import { createUpdateCache } from './update-cache';

/**
 * The contract `commit()` provides and `determine-shared-externals` silently assumes: a committed
 * external's versions are descending by `versionCheck.compare`, whatever order the remotes arrived in.
 *
 * `determine` reads `versions[0]` as "the latest" for `profile.latestSharedExternal`, and keeps the
 * FIRST candidate of equal cost — which only means "the newest tag" because of this sort. Asserting it
 * here is what keeps that assumption checked rather than implied; hand-seeded fixtures reproduce it
 * through the `newestFirst` helper in `lib/testing/domain/externals/version.mock.ts`.
 */
describe('store-remote-entry: committed version order', () => {
  const SCOPE = {
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
    'team/mfe-c': 'http://mfe-c/',
  } as const;

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();

    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-version-order'),
      clearStorage: true,
    });
    adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
      name in SCOPE
        ? Optional.of({ scopeUrl: SCOPE[name as keyof typeof SCOPE], exposes: [] } as RemoteInfo)
        : Optional.empty<RemoteInfo>()
    );
  });

  const dep = (version: string, shareScope?: string): DenseSharedInfo =>
    mockSharedInfo('dep-a', {
      requiredVersion: `~${version.split('.').slice(0, 2).join('.')}.0`,
      version,
      singleton: true,
      strictVersion: true,
      shareScope,
    });

  const entry = (name: keyof typeof SCOPE, shared: DenseSharedInfo[]): RemoteEntry =>
    ({ name, url: `${SCOPE[name]}remoteEntry.json`, exposes: [], shared }) as RemoteEntry;

  const storedTags = (shareScope?: string) =>
    adapters.sharedExternalsRepo.getFromScope(shareScope)['dep-a']!.versions.map(v => v.tag);

  // The invariant itself, phrased exactly as determine relies on it, over every scope in storage.
  const expectDescendingEverywhere = () => {
    const { compare } = adapters.versionCheck;
    for (const shareScope of adapters.sharedExternalsRepo.getScopes({ includeGlobal: true })) {
      const externals = adapters.sharedExternalsRepo.getFromScope(shareScope);
      for (const [name, external] of Object.entries(externals)) {
        const tags = external.versions.map(v => v.tag);
        const descending = [...tags].sort((a, b) => compare(b, a));
        expect(tags, `${shareScope}/${name} is not newest-first`).toEqual(descending);
      }
    }
  };

  describe('init path (process-remote-entries)', () => {
    const init = (entries: RemoteEntry[]) => createProcessRemoteEntries(config, adapters)(entries);

    it('commits versions newest-first when remotes arrive oldest-first', async () => {
      await init([
        entry('team/mfe-a', [dep('2.1.2')]),
        entry('team/mfe-b', [dep('2.1.3')]),
        entry('team/mfe-c', [dep('2.2.0')]),
      ]);

      expect(storedTags()).toEqual(['2.2.0', '2.1.3', '2.1.2']);
      expectDescendingEverywhere();
    });

    it('commits versions newest-first when remotes arrive newest-first', async () => {
      await init([
        entry('team/mfe-c', [dep('2.2.0')]),
        entry('team/mfe-b', [dep('2.1.3')]),
        entry('team/mfe-a', [dep('2.1.2')]),
      ]);

      expect(storedTags()).toEqual(['2.2.0', '2.1.3', '2.1.2']);
      expectDescendingEverywhere();
    });

    it('sorts a shareScope like the global scope', async () => {
      await init([
        entry('team/mfe-a', [dep('2.1.2', 'custom-scope')]),
        entry('team/mfe-b', [dep('2.2.0', 'custom-scope')]),
      ]);

      expect(storedTags('custom-scope')).toEqual(['2.2.0', '2.1.2']);
      expectDescendingEverywhere();
    });
  });

  describe('dynamic path (update-cache)', () => {
    it('keeps the order when a later remote adds an older tag', async () => {
      await createProcessRemoteEntries(config, adapters)([
        entry('team/mfe-a', [dep('2.2.0')]),
        entry('team/mfe-b', [dep('2.1.3')]),
      ]);

      await createUpdateCache(config, adapters)(entry('team/mfe-c', [dep('2.1.2')]));

      expect(storedTags()).toEqual(['2.2.0', '2.1.3', '2.1.2']);
      expectDescendingEverywhere();
    });

    it('keeps the order when a later remote adds a newer tag', async () => {
      await createProcessRemoteEntries(config, adapters)([
        entry('team/mfe-a', [dep('2.1.2')]),
        entry('team/mfe-b', [dep('2.1.3')]),
      ]);

      await createUpdateCache(config, adapters)(entry('team/mfe-c', [dep('2.2.0')]));

      expect(storedTags()).toEqual(['2.2.0', '2.1.3', '2.1.2']);
      expectDescendingEverywhere();
    });
  });
});
