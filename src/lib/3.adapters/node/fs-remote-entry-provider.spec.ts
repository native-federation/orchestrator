/**
 * @jest-environment node
 */
import { createFsRemoteEntryProvider } from './fs-remote-entry-provider';
import { NFError } from 'lib/native-federation.error';
import { readSourceBytes } from './read-source';

jest.mock('./read-source', () => ({
  readSourceBytes: jest.fn(),
}));

describe('createFsRemoteEntryProvider', () => {
  const readBytes = readSourceBytes as jest.Mock;

  beforeEach(() => {
    readBytes.mockReset();
  });

  it('reads and parses the remote entry JSON', async () => {
    readBytes.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({ name: 'r', exposes: [], shared: [], url: 'http://r/remoteEntry.json' })
      ).buffer
    );

    const result = await createFsRemoteEntryProvider().provide('http://r/remoteEntry.json');

    expect(result.name).toBe('r');
    expect(result.url).toBe('http://r/remoteEntry.json');
  });

  it('fills missing exposes/shared/url with defaults', async () => {
    readBytes.mockResolvedValue(new TextEncoder().encode(JSON.stringify({ name: 'r' })).buffer);

    const result = await createFsRemoteEntryProvider().provide('/local/remoteEntry.json');

    expect(result.exposes).toEqual([]);
    expect(result.shared).toEqual([]);
    expect(result.url).toBe('/local/remoteEntry.json');
  });

  it('keeps a url present in the payload over the source URL', async () => {
    readBytes.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify({ name: 'r', url: 'http://canonical/remoteEntry.json' })).buffer
    );

    const result = await createFsRemoteEntryProvider().provide('/local/remoteEntry.json');

    expect(result.url).toBe('http://canonical/remoteEntry.json');
  });

  it('wraps fs/fetch errors in NFError', async () => {
    readBytes.mockRejectedValue(new Error('ENOENT'));

    await expect(createFsRemoteEntryProvider().provide('/missing.json')).rejects.toEqual(
      new NFError("Read of '/missing.json' returned ENOENT")
    );
  });

  it('passes NFError through unchanged', async () => {
    const upstream = new NFError('404 - Not Found');
    readBytes.mockRejectedValue(upstream);

    await expect(
      createFsRemoteEntryProvider().provide('http://nope/remoteEntry.json')
    ).rejects.toBe(upstream);
  });
});
