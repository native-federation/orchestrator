/**
 * @jest-environment node
 */
import { createRemoteEntryProvider } from './remote-entry-provider';
import { ForProvidingRemoteEntries } from 'lib/2.app/driving-ports/for-providing-remote-entries.port';
import { mockFederationInfo_MFE1 } from 'lib/6.mocks/domain/remote-entry/federation-info.mock';
import { mockRemoteEntry_MFE1 } from 'lib/6.mocks/domain/remote-entry/remote-entry.mock';
import { mockScopeUrl_MFE1 } from 'lib/6.mocks/domain/scope-url.mock';
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

describe('createRemoteEntryProvider (integrity)', () => {
  let provider: ForProvidingRemoteEntries;

  beforeEach(() => {
    provider = createRemoteEntryProvider();
  });

  it('should fetch without integrity verification when no integrity is provided', async () => {
    const body = JSON.stringify(mockFederationInfo_MFE1());
    mockBytesFetch(body);

    const result = await provider.provide(`${mockScopeUrl_MFE1()}remoteEntry.json`);

    expect(result).toEqual(mockRemoteEntry_MFE1());
  });

  it('should resolve when integrity matches', async () => {
    const body = JSON.stringify(mockFederationInfo_MFE1());
    const integrity = await sriOf(body);
    mockBytesFetch(body);

    const result = await provider.provide(`${mockScopeUrl_MFE1()}remoteEntry.json`, {
      integrity,
    });

    expect(result).toEqual(mockRemoteEntry_MFE1());
  });

  it('should reject with NFError when integrity does not match', async () => {
    const body = JSON.stringify(mockFederationInfo_MFE1());
    mockBytesFetch(body);

    await expect(
      provider.provide(`${mockScopeUrl_MFE1()}remoteEntry.json`, {
        integrity: 'sha384-' + 'A'.repeat(64),
      })
    ).rejects.toThrow(NFError);
  });

  it('should reject with NFError when integrity prefix is unsupported', async () => {
    const body = JSON.stringify(mockFederationInfo_MFE1());
    mockBytesFetch(body);

    await expect(
      provider.provide(`${mockScopeUrl_MFE1()}remoteEntry.json`, {
        integrity: 'md5-abcdef',
      })
    ).rejects.toThrow(/Unsupported integrity prefix/);
  });
});
