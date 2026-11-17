/**
 * @vitest-environment node
 */
import type { Mock } from 'vitest';
import { createFsRemoteEntryProvider } from './fs-remote-entry-provider';
import { NFError } from 'lib/core/native-federation.error';
import { readSourceBytes } from 'lib/node/utils/read-source';
import { createRemoteEntryProvider } from 'lib/core/3.adapters/http/remote-entry-provider';
import { mockConfig } from 'lib/testing/config.mock';
import type { RemoteEntry } from 'lib/core/1.domain';
import type { TransformRemoteEntry } from 'lib/core/2.app/config';

vi.mock('lib/node/utils/read-source', () => ({
  readSourceBytes: vi.fn(),
}));

describe('createFsRemoteEntryProvider', () => {
  const readBytes = readSourceBytes as Mock;

  beforeEach(() => {
    readBytes.mockReset();
  });

  it('reads and parses the remote entry JSON', async () => {
    readBytes.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({ name: 'r', exposes: [], shared: [], url: 'http://r/remoteEntry.json' })
      ).buffer
    );

    const result = await createFsRemoteEntryProvider(mockConfig()).provide('http://r/remoteEntry.json');

    expect(result.name).toBe('r');
    expect(result.url).toBe('http://r/remoteEntry.json');
  });

  it('fills missing exposes/shared/url with defaults', async () => {
    readBytes.mockResolvedValue(new TextEncoder().encode(JSON.stringify({ name: 'r' })).buffer);

    const result = await createFsRemoteEntryProvider(mockConfig()).provide('/local/remoteEntry.json');

    expect(result.exposes).toEqual([]);
    expect(result.shared).toEqual([]);
    expect(result.url).toBe('/local/remoteEntry.json');
  });

  it('keeps a url present in the payload over the source URL', async () => {
    readBytes.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({ name: 'r', url: 'http://canonical/remoteEntry.json' })
      ).buffer
    );

    const result = await createFsRemoteEntryProvider(mockConfig()).provide('/local/remoteEntry.json');

    expect(result.url).toBe('http://canonical/remoteEntry.json');
  });

  // The browser provider marks a dense entry the same way; parity is pinned below.
  it('marks the shared entries the remote entry publishes dense', async () => {
    const meta = {
      singleton: true,
      strictVersion: true,
      requiredVersion: '^1.0.0',
      version: '1.0.0',
    };
    readBytes.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          name: 'r',
          shared: [
            { ...meta, packageName: '@s/c/table', entries: { '@s/c/table': 'table.js' } },
            { ...meta, packageName: 'rxjs', outFileName: 'rxjs.js' },
          ],
        })
      ).buffer
    );

    const result = await createFsRemoteEntryProvider(mockConfig()).provide('/local/remoteEntry.json');

    expect(result.shared.map(s => [s.packageName, s.dense])).toEqual([
      ['@s/c/table', true],
      ['rxjs', undefined],
    ]);
  });

  it('wraps fs/fetch errors in NFError', async () => {
    readBytes.mockRejectedValue(new Error('ENOENT'));

    await expect(createFsRemoteEntryProvider(mockConfig()).provide('/missing.json')).rejects.toEqual(
      new NFError("Read of '/missing.json' returned ENOENT")
    );
  });

  it('passes NFError through unchanged', async () => {
    const upstream = new NFError('404 - Not Found');
    readBytes.mockRejectedValue(upstream);

    await expect(
      createFsRemoteEntryProvider(mockConfig()).provide('http://nope/remoteEntry.json')
    ).rejects.toBe(upstream);
  });
  // Node reads every remote entry through this provider, http URLs included, so a flat entry (core's default
  // output) must reach the domain in the dense shape, as the browser provider delivers it.
  describe('normalizes like the browser provider', () => {
    const meta = {
      singleton: true,
      strictVersion: false,
      requiredVersion: '^17.0.0',
      version: '17.0.0',
    };
    const flatEntry = {
      name: 'r',
      shared: [
        { ...meta, packageName: '@fw/core', outFileName: '_fw_core.js' },
        { ...meta, packageName: '@fw/core/sub', outFileName: '_fw_core_sub.js' },
        { ...meta, packageName: '@s/c/table', entries: { '@s/c/table': 'table.js' } },
      ],
    };
    const withFlatConversion = (convertFlatSharedInfo: boolean) => {
      const config = mockConfig();
      config.feature.convertFlatSharedInfo = convertFlatSharedInfo;
      return config;
    };
    const serve = (payload: unknown) =>
      readBytes.mockResolvedValue(new TextEncoder().encode(JSON.stringify(payload)).buffer);

    it('wraps a flat entry into the dense shape, keyed by its specifier', async () => {
      serve(flatEntry);

      const result = await createFsRemoteEntryProvider(withFlatConversion(false)).provide(
        '/local/remoteEntry.json'
      );

      expect(result.shared).toEqual([
        { ...meta, packageName: '@fw/core', entries: { '@fw/core': '_fw_core.js' } },
        { ...meta, packageName: '@fw/core/sub', entries: { '@fw/core/sub': '_fw_core_sub.js' } },
        { ...meta, packageName: '@s/c/table', entries: { '@s/c/table': 'table.js' }, dense: true },
      ]);
    });

    it('groups flat entries by npm name under convertFlatSharedInfo', async () => {
      serve(flatEntry);

      const result = await createFsRemoteEntryProvider(withFlatConversion(true)).provide(
        '/local/remoteEntry.json'
      );

      expect(result.shared).toEqual([
        {
          ...meta,
          packageName: '@fw/core',
          entries: { '@fw/core': '_fw_core.js', '@fw/core/sub': '_fw_core_sub.js' },
        },
        { ...meta, packageName: '@s/c/table', entries: { '@s/c/table': 'table.js' }, dense: true },
      ]);
    });

    it.each([false, true])(
      'gives the same remote entry as the browser provider (convertFlatSharedInfo: %s)',
      async convertFlatSharedInfo => {
        const url = 'http://r/remoteEntry.json';
        serve(flatEntry);
        const fetchMock = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(new Response(JSON.stringify(flatEntry)));
        const config = withFlatConversion(convertFlatSharedInfo);

        try {
          const viaFs = await createFsRemoteEntryProvider(config).provide(url);
          const viaHttp = await createRemoteEntryProvider(config).provide(url);

          expect(viaFs).toEqual(viaHttp);
        } finally {
          fetchMock.mockRestore();
        }
      }
    );
  });

  // Node reads every remote entry here, the host entry for `hostInstances` included, so the transform must run
  // in this provider as it does in the browser one.
  describe('devtools.transformRemoteEntryFn', () => {
    const raw = {
      name: 'r',
      shared: [
        {
          singleton: true,
          strictVersion: true,
          requiredVersion: '^1.0.0',
          version: '1.0.0',
          packageName: 'rxjs',
          outFileName: 'rxjs.js',
        },
      ],
    };
    const serve = () =>
      readBytes.mockResolvedValue(new TextEncoder().encode(JSON.stringify(raw)).buffer);

    const providerWith = (transformRemoteEntryFn: TransformRemoteEntry) =>
      createFsRemoteEntryProvider({ ...mockConfig(), devtools: { transformRemoteEntryFn } });

    it('resolves the entry the function returns', async () => {
      serve();

      // Returns a copy and leaves its argument alone, so only a provider that uses the result passes.
      const result = await providerWith(async entry => ({
        ...entry,
        shared: entry.shared.map(s => ({ ...s, singleton: false })),
      })).provide('/local/remoteEntry.json');

      expect(result.shared.map(s => s.singleton)).toEqual([false]);
    });

    it('passes the normalized entry', async () => {
      serve();
      const transform = vi.fn((entry: RemoteEntry) => entry);

      await providerWith(transform).provide('/local/remoteEntry.json');

      expect(transform).toHaveBeenCalledWith({
        name: 'r',
        url: '/local/remoteEntry.json',
        exposes: [],
        shared: [
          {
            singleton: true,
            strictVersion: true,
            requiredVersion: '^1.0.0',
            version: '1.0.0',
            packageName: 'rxjs',
            entries: { rxjs: 'rxjs.js' },
          },
        ],
      });
    });

    it("rejects with the function's own error, not as a failed read", async () => {
      serve();
      const error = new Error('transform failed');

      await expect(
        providerWith(() => {
          throw error;
        }).provide('/local/remoteEntry.json')
      ).rejects.toBe(error);
    });
  });
});
