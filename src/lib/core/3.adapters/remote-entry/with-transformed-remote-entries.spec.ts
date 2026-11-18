import { withTransformedRemoteEntries } from './with-transformed-remote-entries';
import { mockRemoteEntryProvider } from 'lib/testing/adapters/remote-entry-provider.mock';
import { mockRemoteEntry_MFE1 } from 'lib/testing/domain/remote-entry/remote-entry.mock';
import { mockScopeUrl_MFE1 } from 'lib/testing/domain/scope-url.mock';
import { NFError } from 'lib/core/native-federation.error';
import type { RemoteEntry } from 'lib/core/1.domain';

describe('withTransformedRemoteEntries', () => {
  const url = mockScopeUrl_MFE1({ file: 'remoteEntry.json' });

  const provide = (transformRemoteEntryFn: (entry: RemoteEntry) => RemoteEntry) => {
    const provider = mockRemoteEntryProvider();
    provider.provide.mockResolvedValue(mockRemoteEntry_MFE1());
    return {
      provider,
      decorated: withTransformedRemoteEntries(provider, transformRemoteEntryFn),
    };
  };

  it('resolves the entry the function returns', async () => {
    // A copy, so the assertion fails if the provider's own entry is passed through.
    const { decorated } = provide(entry => ({ ...entry, exposes: [] }));

    await expect(decorated.provide(url)).resolves.toEqual({
      ...mockRemoteEntry_MFE1(),
      exposes: [],
    });
  });

  it('forwards the integrity option to the provider', async () => {
    const { provider, decorated } = provide(entry => entry);

    await decorated.provide(url, { integrity: 'sha384-abc' });

    expect(provider.provide).toHaveBeenCalledWith(url, { integrity: 'sha384-abc' });
  });

  it('rejects when the function returns nothing', async () => {
    // A JS host, or a cast, can hand in a transform that only mutates.
    const { decorated } = provide((() => undefined) as never);

    const error = await decorated.provide(url).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NFError);
    expect((error as NFError).message).toContain(url);
    expect((error as NFError).message).toContain('must return the entry');
  });

  it('rejects with its own error when the function throws, keeping the thrown error as cause', async () => {
    const boom = new Error('boom');
    const { decorated } = provide(() => {
      throw boom;
    });

    await expect(decorated.provide(url)).rejects.toEqual(
      new NFError(`transformRemoteEntryFn failed on '${url}': boom`, boom)
    );
  });

  it("passes the provider's rejection through untouched, without calling the function", async () => {
    const fetchError = new NFError(`Fetch of '${url}' returned 404 Not Found`);
    const transform = vi.fn((entry: RemoteEntry) => entry);
    const { provider, decorated } = provide(transform);
    provider.provide.mockRejectedValue(fetchError);

    await expect(decorated.provide(url)).rejects.toBe(fetchError);
    expect(transform).not.toHaveBeenCalled();
  });
});
