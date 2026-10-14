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

  // The committed import map cannot drop a remote's imports, so a dynamic init never replaces a known remote,
  // whatever overrideCachedRemotes says: that setting only applies to initFederation.
  describe('a remote that is already initialized', () => {
    const url = (folder: string) => mockScopeUrl_MFE1({ folder, file: 'remoteEntry.json' });
    const ignored = (folder: string) =>
      `[team/mfe1] Already initialized from '${url('v1')}', ignoring '${url(folder)}'.`;

    beforeEach(() => {
      const info: RemoteInfo = { scopeUrl: mockScopeUrl_MFE1({ folder: 'v1' }), exposes: [] };
      adapters.remoteInfoRepo.contains = vi.fn(name => name === 'team/mfe1');
      adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
        name === 'team/mfe1' ? Optional.of(info) : Optional.empty<RemoteInfo>()
      );
      adapters.remoteInfoRepo.getAll = vi.fn(() => ({ 'team/mfe1': info }));
    });

    const settings = [
      { overrideCachedRemotes: 'never', overrideCachedRemotesIfURLMatches: false },
      { overrideCachedRemotes: 'init-only', overrideCachedRemotesIfURLMatches: false },
      { overrideCachedRemotes: 'always', overrideCachedRemotesIfURLMatches: false },
      { overrideCachedRemotes: 'always', overrideCachedRemotesIfURLMatches: true },
    ] as const;
    const refs = [
      { ref: 'team/mfe1', label: 'its name' },
      { ref: undefined, label: 'no ref' },
      { ref: { integrity: 'sha384-AAA' }, label: 'an integrity-only ref' },
    ];

    // A repeated load is the lazy-route pattern, not an attempt to replace the remote: no fetch, no warning.
    describe.each(settings)('under %o', profile => {
      beforeEach(() => Object.assign(config.profile, profile));

      it.each(refs)(
        'should omit the fetch of the URL it is initialized from given $label',
        async ({ ref }) => {
          const result = await getRemoteEntry(url('v1'), ref);

          expect(adapters.remoteEntryProvider.provide).not.toHaveBeenCalled();
          expect(result.isPresent()).toBe(false);
          expect(config.log.warn).not.toHaveBeenCalled();
          expect(config.log.debug).toHaveBeenCalledWith(
            7,
            `Found remote 'team/mfe1' at '${url('v1')}' in storage, omitting fetch.`
          );
        }
      );

      it('should warn and omit another URL requested by its name, without fetching it', async () => {
        const result = await getRemoteEntry(url('v2'), 'team/mfe1');

        expect(adapters.remoteEntryProvider.provide).not.toHaveBeenCalled();
        expect(result.isPresent()).toBe(false);
        expect(config.log.warn).toHaveBeenCalledWith(7, ignored('v2'));
      });

      // Without its name the remote is only known once its entry is fetched.
      it.each(refs.slice(1))('should warn and omit another URL given $label', async ({ ref }) => {
        const result = await getRemoteEntry(url('v2'), ref);

        expect(adapters.remoteEntryProvider.provide).toHaveBeenCalled();
        expect(result.isPresent()).toBe(false);
        expect(config.log.warn).toHaveBeenCalledWith(7, ignored('v2'));
      });
    });

    it('should warn and omit a fetched remote that is initialized under another name than requested', async () => {
      const result = await getRemoteEntry(url('v2'), 'team/mfe2');

      expect(result.isPresent()).toBe(false);
      expect(config.log.warn).toHaveBeenCalledWith(7, ignored('v2'));
    });
  });

  it('should return a fetched remote that is not initialized when given no name', async () => {
    const result = await getRemoteEntry(
      mockScopeUrl_MFE1({ folder: 'v2', file: 'remoteEntry.json' })
    );

    expect(result.isPresent()).toBe(true);
    expect(result.get().override).toBeUndefined();
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
