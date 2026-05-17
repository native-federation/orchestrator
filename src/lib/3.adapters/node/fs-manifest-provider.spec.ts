/**
 * @jest-environment node
 */
import { createFsManifestProvider } from './fs-manifest-provider';
import { NFError } from 'lib/native-federation.error';
import type { FederationManifest } from 'lib/1.domain';
import { readSourceBytes } from './read-source';

jest.mock('./read-source', () => ({
  readSourceBytes: jest.fn(),
}));

describe('createFsManifestProvider', () => {
  const readBytes = readSourceBytes as jest.Mock;

  beforeEach(() => {
    readBytes.mockReset();
  });

  it('returns a provider with a provide function', () => {
    const provider = createFsManifestProvider();
    expect(typeof provider.provide).toBe('function');
  });

  it('passes through when the input is an object', async () => {
    const provider = createFsManifestProvider();
    const manifest: FederationManifest = { a: 'http://x/remoteEntry.json' };

    const result = await provider.provide(manifest);

    expect(result).toBe(manifest);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('reads + parses JSON when given a string source', async () => {
    const payload: FederationManifest = { a: 'http://x/remoteEntry.json' };
    readBytes.mockResolvedValue(new TextEncoder().encode(JSON.stringify(payload)).buffer);

    const result = await createFsManifestProvider().provide('/tmp/manifest.json');

    expect(readBytes).toHaveBeenCalledWith('/tmp/manifest.json');
    expect(result).toEqual(payload);
  });

  it('wraps non-NFError read failures into NFError with the source URL', async () => {
    readBytes.mockRejectedValue(new Error('ENOENT: no such file'));

    await expect(createFsManifestProvider().provide('/missing.json')).rejects.toEqual(
      new NFError("Read of '/missing.json' returned ENOENT: no such file")
    );
  });

  it('re-throws NFError from the source reader unchanged', async () => {
    const upstream = new NFError('503 - Service Unavailable');
    readBytes.mockRejectedValue(upstream);

    await expect(createFsManifestProvider().provide('http://bad/manifest.json')).rejects.toBe(
      upstream
    );
  });

  it('reports JSON parse errors as NFError', async () => {
    readBytes.mockResolvedValue(new TextEncoder().encode('{not json').buffer);

    await expect(createFsManifestProvider().provide('/broken.json')).rejects.toBeInstanceOf(
      NFError
    );
  });
});
