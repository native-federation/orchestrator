import { createGetRemoteEntries } from './get-remote-entries';
import { DrivingContract } from '../driving-ports/driving.contract';
import { ForGettingRemoteEntries } from '../driver-ports/init/for-getting-remote-entries.port';
import { mockManifest } from 'lib/testing/domain/manifest.mock';
import { NFError } from 'lib/core/native-federation.error';
import { Optional } from 'lib/utils/optional';
import { RemoteInfo } from 'lib/core/1.domain';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import {
  mockScopeUrl_HOST,
  mockScopeUrl_MFE1,
  mockScopeUrl_MFE2,
} from 'lib/testing/domain/scope-url.mock';
import {
  mockRemoteEntry_HOST,
  mockRemoteEntry_MFE1,
  mockRemoteEntry_MFE2,
} from 'lib/testing/domain/remote-entry/remote-entry.mock';

describe('createGetRemoteEntries', () => {
  let getRemoteEntries: ForGettingRemoteEntries;
  let config: any;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();

    adapters.remoteInfoRepo.tryGet = vi.fn(_ => {
      return Optional.empty<RemoteInfo>();
    });

    adapters.remoteEntryProvider.provide = vi.fn((url: string) => {
      if (url.startsWith(mockScopeUrl_MFE1())) {
        return Promise.resolve(mockRemoteEntry_MFE1());
      }
      if (url.startsWith(mockScopeUrl_MFE2())) {
        return Promise.resolve(mockRemoteEntry_MFE2());
      }
      return Promise.reject(new NFError(`Fetch of '${url}' returned 404 Not Found`));
    });

    getRemoteEntries = createGetRemoteEntries(config, adapters);
  });

  describe('fetching remote entries', () => {
    it('should fetch remote entries when given a manifest', async () => {
      const actual = await getRemoteEntries(mockManifest());

      expect(adapters.manifestProvider.provide).toHaveBeenCalledWith(mockManifest());
      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE1()}remoteEntry.json`
      );
      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE2()}remoteEntry.json`
      );

      expect(actual).toEqual([mockRemoteEntry_MFE1(), mockRemoteEntry_MFE2()]);
    });

    it('should use empty manifest when no argument is provided', async () => {
      await getRemoteEntries(undefined as any);
      expect(adapters.manifestProvider.provide).toHaveBeenCalledWith({});
    });

    it('should log debug messages when remotes are fetched', async () => {
      await getRemoteEntries(mockManifest());

      expect(config.log.debug).toHaveBeenNthCalledWith(
        1,
        1,
        `Fetched 'team/mfe1' from 'http://my.service/mfe1/remoteEntry.json', exposing: [{"key":"./wc-comp-a","outFileName":"component-a.js"}]`
      );

      expect(config.log.debug).toHaveBeenNthCalledWith(
        2,
        1,
        `Fetched 'team/mfe2' from 'http://my.service/mfe2/remoteEntry.json', exposing: [{"key":"./wc-comp-b","outFileName":"component-b.js"},{"key":"./wc-comp-c","outFileName":"component-c.js"}]`
      );
    });

    it('should fetch manifest from URL when given a string', async () => {
      const manifestUrl = 'http://my.service/manifest.json';

      const actual = await getRemoteEntries(manifestUrl);

      expect(adapters.manifestProvider.provide).toHaveBeenCalledWith(manifestUrl);

      expect(actual).toEqual([mockRemoteEntry_MFE1(), mockRemoteEntry_MFE2()]);
    });

    it('should add a profile cacheTag query param when fetching remotes', async () => {
      config.profile.cacheTag = '123abc';

      await getRemoteEntries(mockManifest());

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE1()}remoteEntry.json?cacheTag=123abc`
      );
      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE2()}remoteEntry.json?cacheTag=123abc`
      );
    });
  });

  describe('inclusion of host remoteEntry', () => {
    beforeEach(() => {
      adapters.remoteEntryProvider.provide = vi.fn((url: string) => {
        if (url.startsWith(`${mockScopeUrl_HOST()}remoteEntry.json`)) {
          return Promise.resolve(mockRemoteEntry_HOST());
        }
        if (url === `${mockScopeUrl_MFE1()}remoteEntry.json`) {
          return Promise.resolve(mockRemoteEntry_MFE1());
        }
        if (url === `${mockScopeUrl_MFE2()}remoteEntry.json`) {
          return Promise.resolve(mockRemoteEntry_MFE2());
        }
        return Promise.reject(new NFError(`Fetch of '${url}' returned 404 Not Found`));
      });
    });

    it('should process hostRemoteEntry if defined in config', async () => {
      config.hostRemoteEntry = {
        name: 'team/host',
        url: `${mockScopeUrl_HOST()}remoteEntry.json`,
      };
      const actual = await getRemoteEntries(mockManifest());

      expect(actual).toEqual([
        mockRemoteEntry_MFE1(),
        mockRemoteEntry_MFE2(),
        mockRemoteEntry_HOST(),
      ]);
      expect(actual[0]!.host).toBeUndefined();
      expect(actual[1]!.host).toBeUndefined();
      expect(actual[2]!.host).toBe(true);
    });

    it('should add a cacheTag if defined in config', async () => {
      config.hostRemoteEntry = {
        name: 'team/host',
        url: `${mockScopeUrl_HOST()}remoteEntry.json`,
        cacheTag: '123abc',
      };
      const actual = await getRemoteEntries(mockManifest());

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_HOST()}remoteEntry.json?cacheTag=123abc`
      );

      expect(actual).toEqual([
        mockRemoteEntry_MFE1(),
        mockRemoteEntry_MFE2(),
        mockRemoteEntry_HOST(),
      ]);
    });

    it('should not duplicate cacheTag when both host and profile cacheTag are set', async () => {
      config.hostRemoteEntry = {
        name: 'team/host',
        url: `${mockScopeUrl_HOST()}remoteEntry.json`,
        cacheTag: 'host-tag',
      };
      config.profile.cacheTag = 'profile-tag';

      await getRemoteEntries(mockManifest());

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_HOST()}remoteEntry.json?cacheTag=host-tag`
      );
      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE1()}remoteEntry.json?cacheTag=profile-tag`
      );
    });

    it('should rename host remoteName to config defined name', async () => {
      config.hostRemoteEntry = {
        name: 'newHostName',
        url: `${mockScopeUrl_HOST()}remoteEntry.json`,
      };
      const actual = await getRemoteEntries({});

      expect(actual).toEqual([{ ...mockRemoteEntry_HOST(), name: 'newHostName' }]);
    });
  });

  describe('handling existing remotes', () => {
    it('should override fetching remotes that exist in the repository when enabled in config (not same-url)', async () => {
      config.profile.overrideCachedRemotes = 'always';
      config.profile.overrideCachedRemotesIfURLMatches = false;

      // Setup storage to contain one of the remotes
      adapters.remoteInfoRepo.tryGet = vi
        .fn()
        .mockImplementation(_ =>
          Optional.of({ scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }), exposes: [] })
        );

      const actual = await getRemoteEntries({
        'team/mfe1': `${mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })}`,
      });

      expect(actual).toEqual([{ ...mockRemoteEntry_MFE1(), override: true }]);
      expect(config.log.debug).toHaveBeenCalledWith(
        1,
        `Overriding existing remote 'team/mfe1' with '${mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })}'.`
      );
      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })}`
      );
    });

    it('should skip fetching remotes that exist in the repository when disabled in config (same-url)', async () => {
      config.profile.overrideCachedRemotes = 'always';
      config.profile.overrideCachedRemotesIfURLMatches = false;

      // Setup storage to contain one of the remotes
      adapters.remoteInfoRepo.tryGet = vi
        .fn()
        .mockImplementation(_ =>
          Optional.of({ scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }), exposes: [] })
        );

      const actual = await getRemoteEntries({
        'team/mfe1': `${mockScopeUrl_MFE1({ folder: 'v1', file: 'remoteEntry.json' })}`,
      });

      expect(actual).toEqual([]);
      expect(config.log.debug).toHaveBeenCalledWith(
        1,
        `Found remote 'team/mfe1' in storage, omitting fetch.`
      );
      expect(adapters.remoteEntryProvider.provide).not.toHaveBeenCalled();
    });

    it('should skip fetching remotes that exist in the repository when override "never" in config', async () => {
      config.profile.overrideCachedRemotes = 'never';
      config.profile.overrideCachedRemotesIfURLMatches = true;

      // Setup storage to contain one of the remotes
      adapters.remoteInfoRepo.tryGet = vi
        .fn()
        .mockImplementation(_ =>
          Optional.of({ scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }), exposes: [] })
        );

      const actual = await getRemoteEntries({
        'team/mfe1': `${mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })}`,
      });

      expect(actual).toEqual([]);
      expect(config.log.debug).toHaveBeenCalledWith(
        1,
        `Found remote 'team/mfe1' in storage, omitting fetch.`
      );
    });

    it('should override fetching remotes that exist in the repository when override "init-only" in config', async () => {
      config.profile.overrideCachedRemotes = 'init-only';
      config.profile.overrideCachedRemotesIfURLMatches = true;

      // Setup storage to contain one of the remotes
      adapters.remoteInfoRepo.tryGet = vi
        .fn()
        .mockImplementation(_ =>
          Optional.of({ scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }), exposes: [] })
        );

      const actual = await getRemoteEntries({
        'team/mfe1': `${mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })}`,
      });

      expect(actual).toEqual([{ ...mockRemoteEntry_MFE1(), override: true }]);
      expect(config.log.debug).toHaveBeenCalledWith(
        1,
        `Overriding existing remote 'team/mfe1' with '${mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })}'.`
      );
      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })}`
      );
    });
  });

  describe('dropping remotes the manifest does not list (profile.mergeManifests: false)', () => {
    beforeEach(() => {
      config.profile.mergeManifests = false;
    });

    const stored = (remotes: Record<string, string>) => {
      adapters.remoteInfoRepo.getAll = vi.fn(() =>
        Object.fromEntries(
          Object.entries(remotes).map(([name, scopeUrl]) => [name, { scopeUrl, exposes: [] }])
        )
      );
      adapters.remoteInfoRepo.tryGet = vi.fn(name =>
        Optional.of(name in remotes ? { scopeUrl: remotes[name]!, exposes: [] } : undefined)
      ) as any;
    };

    const expectEvicted = (names: string[]) => {
      expect(adapters.remoteInfoRepo.remove.mock.calls.map(([n]) => n)).toEqual(names);
      expect(adapters.scopedExternalsRepo.remove.mock.calls.map(([n]) => n)).toEqual(names);
      expect(adapters.sharedChunksRepo.remove.mock.calls.map(([n]) => n)).toEqual(names);
      if (names.length === 0)
        expect(adapters.sharedExternalsRepo.removeFromAllScopes).not.toHaveBeenCalled();
      else
        expect(adapters.sharedExternalsRepo.removeFromAllScopes).toHaveBeenCalledWith(
          new Set(names)
        );
    };

    it('should drop a stored remote the manifest no longer lists', async () => {
      stored({ 'team/mfe1': mockScopeUrl_MFE1(), 'team/mfe2': mockScopeUrl_MFE2() });

      const actual = await getRemoteEntries({
        'team/mfe2': `${mockScopeUrl_MFE2()}remoteEntry.json`,
      });

      expectEvicted(['team/mfe1']);
      expect(actual).toEqual([]);
      expect(config.log.debug).toHaveBeenCalledWith(
        1,
        `Removing stored remotes the manifest doesn't list: team/mfe1.`
      );
    });

    // Pages may each pass their own manifest, and storage merges them on purpose.
    it('should neither read nor drop stored remotes when merging manifests', async () => {
      config.profile.mergeManifests = true;
      stored({ 'team/mfe1': mockScopeUrl_MFE1(), 'team/mfe2': mockScopeUrl_MFE2() });

      await getRemoteEntries({ 'team/mfe2': `${mockScopeUrl_MFE2()}remoteEntry.json` });

      expect(adapters.remoteInfoRepo.getAll).not.toHaveBeenCalled();
      expectEvicted([]);
    });

    it('should drop nothing when the manifest lists every stored remote', async () => {
      stored({ 'team/mfe1': mockScopeUrl_MFE1() });

      await getRemoteEntries(mockManifest());

      expectEvicted([]);
    });

    it('should keep the host, which the manifest does not list itself', async () => {
      config.hostRemoteEntry = { name: 'team/host', url: `${mockScopeUrl_HOST()}remoteEntry.json` };
      stored({ 'team/host': mockScopeUrl_HOST(), 'team/mfe1': mockScopeUrl_MFE1() });

      await getRemoteEntries({});

      expectEvicted(['team/mfe1']);
    });

    // prepareRemoteEntry stores a remote under its fetched name when it differs from the manifest key; matching
    // keys alone would drop and refetch it on every warm init.
    it('should keep a remote stored under another name than its manifest key', async () => {
      stored({ 'team/mfe1': mockScopeUrl_MFE1() });

      await getRemoteEntries({ 'other/name': `${mockScopeUrl_MFE1()}remoteEntry.json` });

      expectEvicted([]);
    });

    it('should keep a listed remote whose fetch fails', async () => {
      config.profile.overrideCachedRemotesIfURLMatches = true;
      stored({ 'team/mfe1': mockScopeUrl_MFE1() });
      adapters.remoteEntryProvider.provide = vi.fn(() => Promise.reject(new NFError('404')));

      await getRemoteEntries({ 'team/mfe1': `${mockScopeUrl_MFE1()}remoteEntry.json` });

      expectEvicted([]);
    });

    // Storage is written by commit-changes only, so a later failing step persists no drop.
    it('should not commit any repository', async () => {
      stored({ 'team/mfe1': mockScopeUrl_MFE1() });

      await getRemoteEntries({});

      expectEvicted(['team/mfe1']);
      expect(adapters.remoteInfoRepo.commit).not.toHaveBeenCalled();
      expect(adapters.scopedExternalsRepo.commit).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.commit).not.toHaveBeenCalled();
      expect(adapters.sharedChunksRepo.commit).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle failed remote fetch in non-strict mode', async () => {
      config.strict.strictRemoteEntry = false;
      adapters.remoteEntryProvider.provide = vi.fn(url => {
        if (url === `${mockScopeUrl_MFE1()}remoteEntry.json`) {
          return Promise.resolve(mockRemoteEntry_MFE1());
        }

        // remote 2
        return Promise.reject(new NFError(`Failed to fetch remoteEntry from ${url}`));
      });

      const actual = await getRemoteEntries(mockManifest());

      expect(actual).toEqual([mockRemoteEntry_MFE1()]);

      expect(config.log.warn).toHaveBeenCalledWith(
        1,
        "Could not fetch remote 'team/mfe2'. skipping init.",
        expect.any(NFError)
      );
    });

    it('should throw error when remote fetch fails in strict mode', async () => {
      config.strict.strictRemoteEntry = true;

      adapters.remoteEntryProvider.provide = vi.fn(url => {
        if (url === `${mockScopeUrl_MFE2()}remoteEntry.json`) {
          return Promise.resolve(mockRemoteEntry_MFE2());
        }
        return Promise.reject(new NFError(`Failed to fetch remoteEntry from ${url}`));
      });

      await expect(getRemoteEntries(mockManifest())).rejects.toEqual(
        new NFError("Could not fetch remote 'team/mfe1'")
      );

      expect(config.log.error).toHaveBeenCalledWith(
        1,
        "Could not fetch remote 'team/mfe1'.",
        expect.any(NFError)
      );
    });

    it('should throw error when manifest provider fails', async () => {
      adapters.manifestProvider.provide = vi
        .fn()
        .mockRejectedValue(new NFError('Failed to fetch manifest'));

      await expect(getRemoteEntries('http://bad.manifest.url')).rejects.toEqual(
        new NFError('Failed to fetch manifest')
      );

      expect(config.log.error).toHaveBeenCalledWith(
        1,
        'Could not fetch manifest.',
        expect.any(NFError)
      );
    });

    it('should warn when remote entry name does not match requested name', async () => {
      const manifestWithBadEntryName = {
        'bad-mfe-name': `${mockScopeUrl_MFE1()}remoteEntry.json`,
      };

      await getRemoteEntries(manifestWithBadEntryName);

      expect(config.log.warn).toHaveBeenCalledWith(
        1,
        "Fetched remote 'team/mfe1' does not match requested 'bad-mfe-name'. Omitting expected name."
      );
    });

    it('should throw an error when remote entry name does not match requested name on strict mode', () => {
      config.strict.strictRemoteEntry = true;
      const manifestWithBadEntryName = {
        'bad-mfe-name': `${mockScopeUrl_MFE1()}remoteEntry.json`,
      };

      expect(getRemoteEntries(manifestWithBadEntryName)).rejects.toEqual(
        new NFError("Could not fetch remote 'bad-mfe-name'")
      );
    });
  });

  describe('integrity', () => {
    it('should accept manifest entries in object form with integrity', async () => {
      await getRemoteEntries({
        'team/mfe1': {
          url: `${mockScopeUrl_MFE1()}remoteEntry.json`,
          integrity: 'sha384-AAA',
        },
      });

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE1()}remoteEntry.json`,
        { integrity: 'sha384-AAA' }
      );
    });

    it('should not pass an opts arg when manifest entry has no integrity', async () => {
      await getRemoteEntries({
        'team/mfe1': `${mockScopeUrl_MFE1()}remoteEntry.json`,
      });

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE1()}remoteEntry.json`
      );
    });

    it('should pass manifestIntegrity to the manifest provider when configured', async () => {
      config.manifestIntegrity = 'sha384-MAN';

      await getRemoteEntries('http://host/manifest.json');

      expect(adapters.manifestProvider.provide).toHaveBeenCalledWith('http://host/manifest.json', {
        integrity: 'sha384-MAN',
      });
    });

    it('should propagate hostRemoteEntry integrity to the provider', async () => {
      config.hostRemoteEntry = {
        name: 'team/host',
        url: `${mockScopeUrl_HOST()}remoteEntry.json`,
        integrity: 'sha384-HOST',
      };
      adapters.remoteEntryProvider.provide = vi.fn((url: string) => {
        if (url.startsWith(`${mockScopeUrl_HOST()}remoteEntry.json`)) {
          return Promise.resolve(mockRemoteEntry_HOST());
        }
        return Promise.reject(new NFError(`Fetch of '${url}' returned 404`));
      });

      await getRemoteEntries({});

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_HOST()}remoteEntry.json`,
        { integrity: 'sha384-HOST' }
      );
    });
  });
});
