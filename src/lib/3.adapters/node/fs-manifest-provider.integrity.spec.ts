/**
 * @jest-environment node
 */
import { createFsManifestProvider } from './fs-manifest-provider';
import { NFError } from 'lib/native-federation.error';
import { readSourceBytes } from 'lib/utils/node/read-source';
import { verifyIntegrity } from 'lib/utils/integrity';

jest.mock('lib/utils/node/read-source', () => ({
  readSourceBytes: jest.fn(),
}));

jest.mock('lib/utils/integrity', () => ({
  verifyIntegrity: jest.fn(),
}));

describe('createFsManifestProvider (integrity)', () => {
  const readBytes = readSourceBytes as jest.Mock;
  const verify = verifyIntegrity as jest.Mock;

  beforeEach(() => {
    readBytes.mockReset();
    verify.mockReset();
  });

  it('verifies integrity before parsing when an integrity hash is supplied', async () => {
    const bytes = new TextEncoder().encode('{"a":"http://x"}').buffer;
    readBytes.mockResolvedValue(bytes);
    verify.mockResolvedValue(undefined);

    const result = await createFsManifestProvider().provide('/tmp/manifest.json', {
      integrity: 'sha256-deadbeef',
    });

    expect(verify).toHaveBeenCalledWith(bytes, 'sha256-deadbeef');
    expect(result).toEqual({ a: 'http://x' });
  });

  it('skips integrity verification when no hash is supplied', async () => {
    readBytes.mockResolvedValue(new TextEncoder().encode('{}').buffer);

    await createFsManifestProvider().provide('/tmp/manifest.json');

    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects when integrity verification fails', async () => {
    readBytes.mockResolvedValue(new TextEncoder().encode('{}').buffer);
    verify.mockRejectedValue(new Error('Integrity mismatch: expected X, got Y'));

    await expect(
      createFsManifestProvider().provide('/tmp/m.json', { integrity: 'sha256-x' })
    ).rejects.toEqual(new NFError("Read of '/tmp/m.json' returned Integrity mismatch: expected X, got Y"));
  });
});
