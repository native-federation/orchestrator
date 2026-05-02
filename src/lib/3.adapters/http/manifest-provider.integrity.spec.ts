/**
 * @jest-environment node
 */
import { createManifestProvider } from './manifest-provider';
import { ForProvidingManifest } from 'lib/2.app/driving-ports/for-providing-manifest.port';
import { NFError } from 'lib/native-federation.error';

const sriOf = async (input: string): Promise<string> => {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-384', bytes);
  const view = new Uint8Array(digest);
  let bin = '';
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]!);
  return 'sha384-' + btoa(bin);
};

const mockBytesFetch = (body: string) => {
  global.fetch = jest.fn(async () => {
    const bytes = new TextEncoder().encode(body);
    return {
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(bytes.buffer),
      json: () => Promise.resolve(JSON.parse(body)),
    } as Response;
  }) as jest.Mock;
};

describe('createManifestProvider (integrity)', () => {
  let provider: ForProvidingManifest;

  beforeEach(() => {
    provider = createManifestProvider();
  });

  it('should pass through object manifests untouched even when integrity is given', async () => {
    const manifest = { 'team/mfe1': 'http://my.service/mfe1/remoteEntry.json' };

    const result = await provider.provide(manifest, { integrity: 'sha384-AAA' });

    expect(result).toEqual(manifest);
  });

  it('should resolve when manifest URL matches integrity', async () => {
    const manifest = { 'team/mfe1': 'http://my.service/mfe1/remoteEntry.json' };
    const body = JSON.stringify(manifest);
    mockBytesFetch(body);
    const integrity = await sriOf(body);

    const result = await provider.provide('http://host/manifest.json', { integrity });

    expect(result).toEqual(manifest);
  });

  it('should reject with NFError when manifest integrity does not match', async () => {
    const body = JSON.stringify({ 'team/mfe1': 'http://my.service/mfe1/remoteEntry.json' });
    mockBytesFetch(body);

    await expect(
      provider.provide('http://host/manifest.json', {
        integrity: 'sha384-' + 'A'.repeat(64),
      })
    ).rejects.toThrow(NFError);
  });
});
