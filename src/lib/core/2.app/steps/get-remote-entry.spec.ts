import { createGetRemoteEntry } from './get-remote-entry';
import { DrivingContract } from '../driving-ports/driving.contract';
import { ForGettingRemoteEntry } from 'lib/core/2.app/driver-ports/init/for-getting-remote-entry.port';
import { Optional } from 'lib/utils/optional';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { NFError } from 'lib/core/native-federation.error';
import { mockRemoteEntry_MFE1 } from 'lib/testing/domain/remote-entry/remote-entry.mock';
import { mockScopeUrl_MFE1 } from 'lib/testing/domain/scope-url.mock';
import { RemoteInfo } from 'lib/core/1.domain';

describe('createGetRemoteEntry', () => {
  let getRemoteEntry: ForGettingRemoteEntry;
  let config: any;
  let adapters: Pick<DrivingContract, 'remoteEntryProvider' | 'remoteInfoRepo' | 'sse'>;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();

    adapters.remoteInfoRepo.tryGet = vi.fn(() => Optional.empty());
    adapters.remoteInfoRepo.getAll = vi.fn(() => ({}));

    getRemoteEntry = createGetRemoteEntry(config, adapters);

    adapters.remoteEntryProvider.provide = vi.fn((url: string) => {
      if (url.startsWith(mockScopeUrl_MFE1())) {
        return Promise.resolve({ ...mockRemoteEntry_MFE1(), url });
      }
      return Promise.reject(new NFError(`Fetch of '${url}' returned 404 Not Found`));
    });
  });

  describe('fetching remote entry', () => {
    it('should fetch the given remoteEntry', async () => {
      const result = await getRemoteEntry(`${mockScopeUrl_MFE1()}remoteEntry.json`, 'team/mfe1');

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        mockScopeUrl_MFE1({ file: 'remoteEntry.json' })
      );

      expect(result.get()).toEqual(mockRemoteEntry_MFE1());
    });

    it('should throw error if remoteEntryProvider fails', async () => {
      adapters.remoteEntryProvider.provide = vi.fn().mockRejectedValue(new Error('Fetch error'));

      await expect(
        getRemoteEntry(mockScopeUrl_MFE1({ file: 'remoteEntry.json' }), 'team/mfe1')
      ).rejects.toThrow('Could not fetch remoteEntry.');
    });

    it('should skip fetching remote if it exists in repository and overrideCachedRemotes is never', async () => {
      config.profile.overrideCachedRemotes = 'never';
      adapters.remoteInfoRepo.tryGet = vi.fn(() =>
        Optional.of<RemoteInfo>({
          scopeUrl: mockScopeUrl_MFE1(),
          exposes: [],
        })
      );

      const result = await getRemoteEntry(
        mockScopeUrl_MFE1({ file: 'remoteEntry.json' }),
        'team/mfe1'
      );
      expect(adapters.remoteInfoRepo.tryGet).toHaveBeenCalledWith('team/mfe1');

      expect(adapters.remoteEntryProvider.provide).not.toHaveBeenCalled();

      expect(result.isPresent()).toBe(false);
    });

    it('should log a warning if fetched remote name does not match requested name', async () => {
      const result = await getRemoteEntry(
        mockScopeUrl_MFE1({ file: 'remoteEntry.json' }),
        'team/mfe2'
      );

      expect(config.log.warn).toHaveBeenCalledWith(
        7,
        `Fetched remote 'team/mfe1' does not match requested 'team/mfe2'. Omitting expected name.`
      );

      expect(result.isPresent()).toBe(true);
      expect(result.get()!.name).toBe('team/mfe1');
      expect(result.get()!.url).toBe(mockScopeUrl_MFE1({ file: 'remoteEntry.json' }));
    });

    it('should reject if fetched remote name does not match requested name on strict mode', async () => {
      config.strict.strictRemoteEntry = true;
      await expect(
        getRemoteEntry(mockScopeUrl_MFE1({ file: 'remoteEntry.json' }), 'team/mfe2')
      ).rejects.toThrow('Could not fetch remoteEntry.');

      expect(config.log.error).toHaveBeenCalledWith(
        7,
        "Fetched remote 'team/mfe1' does not match requested 'team/mfe2'."
      );
      expect(config.log.error).toHaveBeenCalledWith(
        7,
        '[team/mfe2] Could not fetch remoteEntry from http://my.service/mfe1/remoteEntry.json.',
        new NFError('Could not fetch remote entry')
      );
    });
  });

  describe('overriding cached remotes', () => {
    it('should override fetching remote if it exists in repository and overrideCachedRemotes is always', async () => {
      config.profile.overrideCachedRemotes = 'always';
      adapters.remoteInfoRepo.tryGet = vi.fn(() =>
        Optional.of<RemoteInfo>({
          scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }),
          exposes: [],
        })
      );

      const result = await getRemoteEntry(
        mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' }),
        'team/mfe1'
      );
      expect(adapters.remoteInfoRepo.tryGet).toHaveBeenCalledWith('team/mfe1');

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })
      );

      expect(result.isPresent()).toEqual(true);
    });

    it('should not override fetching remote if it exists in repository and overrideCachedRemotes is init-only', async () => {
      config.profile.overrideCachedRemotes = 'init-only';
      adapters.remoteInfoRepo.tryGet = vi.fn(() =>
        Optional.of<RemoteInfo>({
          scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }),
          exposes: [],
        })
      );

      const result = await getRemoteEntry(
        mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' }),
        'team/mfe1'
      );
      expect(adapters.remoteInfoRepo.tryGet).toHaveBeenCalledWith('team/mfe1');

      expect(adapters.remoteEntryProvider.provide).not.toHaveBeenCalled();

      expect(result.isPresent()).toEqual(false);
    });

    it('should not override fetching remote if it exists in repository and overrideCachedRemotes is never', async () => {
      config.profile.overrideCachedRemotes = 'never';
      adapters.remoteInfoRepo.tryGet = vi.fn(() =>
        Optional.of<RemoteInfo>({
          scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }),
          exposes: [],
        })
      );

      const result = await getRemoteEntry(
        mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' }),
        'team/mfe1'
      );
      expect(adapters.remoteInfoRepo.tryGet).toHaveBeenCalledWith('team/mfe1');

      expect(adapters.remoteEntryProvider.provide).not.toHaveBeenCalled();

      expect(result.isPresent()).toEqual(false);
    });

    it('should skip fetching remote if URL matches cached remote info', async () => {
      config.profile.overrideCachedRemotes = 'always';
      config.profile.overrideCachedRemotesIfURLMatches = false;

      adapters.remoteInfoRepo.tryGet = vi.fn(() =>
        Optional.of<RemoteInfo>({
          scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }),
          exposes: [],
        })
      );

      const result = await getRemoteEntry(
        mockScopeUrl_MFE1({ folder: 'v1', file: 'remoteEntry.json' }),
        'team/mfe1'
      );
      expect(adapters.remoteInfoRepo.tryGet).toHaveBeenCalledWith('team/mfe1');

      expect(adapters.remoteEntryProvider.provide).not.toHaveBeenCalled();

      expect(result.isPresent()).toEqual(false);
    });

    it('should override remote if URL matches cached remote info and enabled in config', async () => {
      config.profile.overrideCachedRemotes = 'always';
      config.profile.overrideCachedRemotesIfURLMatches = true;
      adapters.remoteInfoRepo.contains = vi.fn(() => true);

      adapters.remoteInfoRepo.tryGet = vi.fn(() =>
        Optional.of<RemoteInfo>({
          scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }),
          exposes: [],
        })
      );

      const result = await getRemoteEntry(
        mockScopeUrl_MFE1({ folder: 'v1', file: 'remoteEntry.json' }),
        'team/mfe1'
      );
      expect(adapters.remoteInfoRepo.tryGet).toHaveBeenCalledWith('team/mfe1');

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        mockScopeUrl_MFE1({ folder: 'v1', file: 'remoteEntry.json' })
      );

      expect(result.isPresent()).toEqual(true);
      expect(result.get()).toEqual({
        ...mockRemoteEntry_MFE1(),
        url: mockScopeUrl_MFE1({ folder: 'v1', file: 'remoteEntry.json' }),
        override: true,
      });
    });

    // Without a name the overrideCachedRemotes check cannot run before the fetch, so even 'always' only
    // replaces a remote that is requested by name.
    it.each([
      { ref: undefined, label: 'no ref' },
      { ref: { integrity: 'sha384-AAA' }, label: 'an integrity-only ref' },
    ])(
      'should warn and omit a fetched remote that is already initialized when given $label',
      async ({ ref }) => {
        config.profile.overrideCachedRemotes = 'always';
        config.profile.overrideCachedRemotesIfURLMatches = true;
        adapters.remoteInfoRepo.contains = vi.fn(() => true);
        adapters.remoteInfoRepo.tryGet = vi.fn(() =>
          Optional.of<RemoteInfo>({ scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }), exposes: [] })
        );

        const result = await getRemoteEntry(
          mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' }),
          ref
        );

        expect(adapters.remoteEntryProvider.provide).toHaveBeenCalled();
        expect(result.isPresent()).toEqual(false);
        expect(config.log.warn).toHaveBeenCalledWith(
          7,
          `[team/mfe1] Already initialized from '${mockScopeUrl_MFE1({ folder: 'v1', file: 'remoteEntry.json' })}', ignoring '${mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })}'.`
        );
      }
    );

    // A repeated unnamed load is the lazy-route pattern, not an attempt to replace the remote: no fetch, no warning.
    it.each([
      { ref: undefined, label: 'no ref' },
      { ref: { integrity: 'sha384-AAA' }, label: 'an integrity-only ref' },
    ])(
      'should omit the fetch of a URL a remote is already initialized from when given $label',
      async ({ ref }) => {
        config.profile.overrideCachedRemotes = 'always';
        config.profile.overrideCachedRemotesIfURLMatches = true;
        adapters.remoteInfoRepo.getAll = vi.fn(() => ({
          'team/mfe1': { scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }), exposes: [] },
        }));

        const result = await getRemoteEntry(
          mockScopeUrl_MFE1({ folder: 'v1', file: 'remoteEntry.json' }),
          ref
        );

        expect(adapters.remoteEntryProvider.provide).not.toHaveBeenCalled();
        expect(result.isPresent()).toEqual(false);
        expect(config.log.warn).not.toHaveBeenCalled();
        expect(config.log.debug).toHaveBeenCalledWith(
          7,
          `Found remote 'team/mfe1' at '${mockScopeUrl_MFE1({ folder: 'v1', file: 'remoteEntry.json' })}' in storage, omitting fetch.`
        );
      }
    );

    // The requested name passed the check, but the fetched entry is another remote that is already initialized.
    it('should omit a fetched remote that is already initialized under another name than requested', async () => {
      config.profile.overrideCachedRemotes = 'always';
      adapters.remoteInfoRepo.contains = vi.fn(name => name === 'team/mfe1');
      adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
        name === 'team/mfe1'
          ? Optional.of<RemoteInfo>({ scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }), exposes: [] })
          : Optional.empty<RemoteInfo>()
      );

      const result = await getRemoteEntry(
        mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' }),
        'team/mfe2'
      );

      expect(result.isPresent()).toEqual(false);
      expect(config.log.warn).toHaveBeenCalledWith(
        7,
        `[team/mfe1] Already initialized from '${mockScopeUrl_MFE1({ folder: 'v1', file: 'remoteEntry.json' })}', ignoring '${mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })}'.`
      );
    });

    it('should still return a fetched remote that is not initialized when given no name', async () => {
      adapters.remoteInfoRepo.contains = vi.fn(() => false);

      const result = await getRemoteEntry(
        mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })
      );

      expect(result.isPresent()).toEqual(true);
      expect(result.get().override).toBeUndefined();
    });
  });

  describe('integrity', () => {
    it('should pass integrity to provider when remote is given as object with integrity', async () => {
      await getRemoteEntry(`${mockScopeUrl_MFE1()}remoteEntry.json`, {
        name: 'team/mfe1',
        integrity: 'sha384-AAA',
      });

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE1()}remoteEntry.json`,
        { integrity: 'sha384-AAA' }
      );
    });

    it('should not pass an opts arg when remote has no integrity', async () => {
      await getRemoteEntry(`${mockScopeUrl_MFE1()}remoteEntry.json`, 'team/mfe1');

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE1()}remoteEntry.json`
      );
    });

    it('should accept an integrity-only ref (no name)', async () => {
      await getRemoteEntry(`${mockScopeUrl_MFE1()}remoteEntry.json`, {
        integrity: 'sha384-AAA',
      });

      expect(adapters.remoteEntryProvider.provide).toHaveBeenCalledWith(
        `${mockScopeUrl_MFE1()}remoteEntry.json`,
        { integrity: 'sha384-AAA' }
      );
    });
  });
});
