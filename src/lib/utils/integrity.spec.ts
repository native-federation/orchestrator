/**
 * @jest-environment node
 */
import { verifyIntegrity } from './integrity';

const encode = (s: string): ArrayBuffer => {
  const buf = new TextEncoder().encode(s);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

const sriOf = async (algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512', input: string) => {
  const digest = await crypto.subtle.digest(algorithm, encode(input));
  const view = new Uint8Array(digest);
  let bin = '';
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]!);
  const prefix =
    algorithm === 'SHA-256' ? 'sha256-' : algorithm === 'SHA-384' ? 'sha384-' : 'sha512-';
  return prefix + btoa(bin);
};

describe('verifyIntegrity', () => {
  it('should resolve when sha384 hash matches', async () => {
    const payload = '{"hello":"world"}';
    const expected = await sriOf('SHA-384', payload);

    await expect(verifyIntegrity(encode(payload), expected)).resolves.toBeUndefined();
  });

  it('should resolve for sha256 and sha512', async () => {
    const payload = '{"a":1}';
    const sha256 = await sriOf('SHA-256', payload);
    const sha512 = await sriOf('SHA-512', payload);

    await expect(verifyIntegrity(encode(payload), sha256)).resolves.toBeUndefined();
    await expect(verifyIntegrity(encode(payload), sha512)).resolves.toBeUndefined();
  });

  it('should reject when the hash does not match', async () => {
    const payload = '{"hello":"world"}';
    const wrong = 'sha384-' + 'A'.repeat(64);

    await expect(verifyIntegrity(encode(payload), wrong)).rejects.toThrow(/Integrity mismatch/);
  });

  it('should reject for an unsupported algorithm prefix', async () => {
    await expect(verifyIntegrity(encode('x'), 'md5-abcdef')).rejects.toThrow(
      /Unsupported integrity prefix/
    );
  });
});
