import type { Mock } from 'vitest';
import { createRemoteEntryProvider } from './remote-entry-provider';
import { RemoteEntry } from 'lib/core/1.domain/remote-entry/remote-entry.contract';
import { ForProvidingRemoteEntries } from 'lib/core/2.app/driving-ports/for-providing-remote-entries.port';
import { mockFederationInfo_MFE1 } from 'lib/testing/domain/remote-entry/federation-info.mock';
import { mockRemoteEntry_MFE1 } from 'lib/testing/domain/remote-entry/remote-entry.mock';
import { mockScopeUrl_MFE1 } from 'lib/testing/domain/scope-url.mock';
import { mockConfig } from 'lib/testing/config.mock';
import { NFError } from 'lib/core/native-federation.error';

describe('createRemoteEntryProvider', () => {
  let remoteEntryProvider: ForProvidingRemoteEntries;

  const mockFetchAPI = (response: Partial<RemoteEntry>, opt: { success: boolean }) => {
    global.fetch = vi.fn(_ => {
      if (opt.success) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(response),
        } as Response);
      }

      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);
    }) as Mock;
  };

  beforeEach(() => {
    remoteEntryProvider = createRemoteEntryProvider(mockConfig());
  });

  describe('provide', () => {
    it('should fetch and return the remote entry', async () => {
      mockFetchAPI(mockFederationInfo_MFE1(), { success: true });

      const result = await remoteEntryProvider.provide(`${mockScopeUrl_MFE1()}remoteEntry.json`);

      expect(fetch).toHaveBeenCalledWith(`${mockScopeUrl_MFE1()}remoteEntry.json`);
      // The fixture publishes every shared entry dense.
      const expected = mockRemoteEntry_MFE1();
      expect(result).toEqual({
        ...expected,
        shared: expected.shared.map(s => ({ ...s, dense: true })),
      });
    });

    it('should fill empty fields with defaults', async () => {
      mockFetchAPI({ name: 'test-remote' }, { success: true });

      const result = await remoteEntryProvider.provide(`${mockScopeUrl_MFE1()}remoteEntry.json`);

      expect(result).toEqual({
        name: 'test-remote',
        url: `${mockScopeUrl_MFE1()}remoteEntry.json`,
        exposes: [],
        shared: [],
      });
    });

    it('should reject with NFError when fetch fails', async () => {
      mockFetchAPI(mockFederationInfo_MFE1(), { success: false });

      await expect(
        remoteEntryProvider.provide('http://bad.service/remoteEntry.js')
      ).rejects.toEqual(
        new NFError("Fetch of 'http://bad.service/remoteEntry.js' returned 404 - Not Found")
      );
    });

    it('should reject with NFError when JSON parsing fails', async () => {
      global.fetch = vi.fn(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error('Invalid JSON')),
        } as unknown as Response);
      }) as Mock;

      await expect(
        remoteEntryProvider.provide(`${mockScopeUrl_MFE1()}remoteEntry.json`)
      ).rejects.toEqual(
        new NFError("Fetch of 'http://my.service/mfe1/remoteEntry.json' returned Invalid JSON")
      );
    });
  });

  // Normalizing wraps a flat entry into the dense shape, so only the raw remoteEntry tells the two apart.
  describe('dense mark', () => {
    const meta = {
      singleton: true,
      strictVersion: true,
      requiredVersion: '^1.0.0',
      version: '1.0.0',
    };
    const flat = (packageName: string) => ({ ...meta, packageName, outFileName: 'flat.js' });
    const dense = (packageName: string, entries: Record<string, string>) => ({
      ...meta,
      packageName,
      entries,
    });

    const provideShared = async (shared: object[], convertFlatSharedInfo: boolean) => {
      const config = mockConfig();
      config.feature.convertFlatSharedInfo = convertFlatSharedInfo;
      mockFetchAPI({ name: 'r', shared } as Partial<RemoteEntry>, { success: true });
      const result = await createRemoteEntryProvider(config).provide('http://r/remoteEntry.json');
      return result.shared.map(({ packageName, entries, dense }) => ({
        packageName,
        entries: Object.keys(entries),
        dense,
      }));
    };

    it.each([false, true])(
      'leaves a flat entry unmarked (convertFlatSharedInfo: %s)',
      async convertFlatSharedInfo => {
        const shared = await provideShared([flat('@s/c/t')], convertFlatSharedInfo);

        // Off wraps it under its own specifier, on groups it by the name rule; neither is a declaration.
        expect(shared).toEqual([
          {
            packageName: convertFlatSharedInfo ? '@s/c' : '@s/c/t',
            entries: ['@s/c/t'],
            dense: undefined,
          },
        ]);
      }
    );

    it.each([false, true])(
      'marks every dense entry, deeper than the name rule or not (convertFlatSharedInfo: %s)',
      async convertFlatSharedInfo => {
        const shared = await provideShared(
          [
            dense('@s/c/table', { '@s/c/table': 'table.js' }),
            dense('@s/forms', { '@s/forms': 'forms.js', '@s/forms/input': 'input.js' }),
            dense('@angular/core', { '@angular/core': 'core.js' }),
            flat('rxjs'),
          ],
          convertFlatSharedInfo
        );

        expect(shared).toEqual([
          { packageName: '@s/c/table', entries: ['@s/c/table'], dense: true },
          { packageName: '@s/forms', entries: ['@s/forms', '@s/forms/input'], dense: true },
          { packageName: '@angular/core', entries: ['@angular/core'], dense: true },
          { packageName: 'rxjs', entries: ['rxjs'], dense: undefined },
        ]);
      }
    );
  });
});
