/**
 * @jest-environment node
 */
import { createFsRemoteEntryProvider } from './fs-remote-entry-provider';
import { NFError } from 'lib/native-federation.error';
import { readSourceBytes } from 'lib/utils/node/read-source';
import { verifyIntegrity } from 'lib/utils/integrity';

jest.mock('lib/utils/node/read-source', () => ({
  readSourceBytes: jest.fn(),
}));

jest.mock('lib/utils/integrity', () => ({
  verifyIntegrity: jest.fn(),
}));

describe('createFsRemoteEntryProvider (integrity)', () => {
  const readBytes = readSourceBytes as jest.Mock;
  const verify = verifyIntegrity as jest.Mock;

  beforeEach(() => {
    readBytes.mockReset();
    verify.mockReset();
  });

  it('verifies integrity when supplied', async () => {
    const bytes = new TextEncoder().encode('{"name":"r"}').buffer;
    readBytes.mockResolvedValue(bytes);
    verify.mockResolvedValue(undefined);

    await createFsRemoteEntryProvider().provide('/r.json', { integrity: 'sha512-abc' });

    expect(verify).toHaveBeenCalledWith(bytes, 'sha512-abc');
  });

  it('skips integrity when not supplied', async () => {
    readBytes.mockResolvedValue(new TextEncoder().encode('{"name":"r"}').buffer);

    await createFsRemoteEntryProvider().provide('/r.json');

    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects with NFError when integrity fails', async () => {
    readBytes.mockResolvedValue(new TextEncoder().encode('{"name":"r"}').buffer);
    verify.mockRejectedValue(new Error('Integrity mismatch'));

    await expect(
      createFsRemoteEntryProvider().provide('/r.json', { integrity: 'sha256-x' })
    ).rejects.toEqual(new NFError("Read of '/r.json' returned Integrity mismatch"));
  });
});
