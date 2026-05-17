/**
 * @jest-environment node
 */
import * as fs from 'node:fs/promises';
import { readSourceBytes } from './read-source';
import { NFError } from 'lib/native-federation.error';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));

describe('readSourceBytes', () => {
  const readFile = fs.readFile as unknown as jest.Mock;

  beforeEach(() => {
    readFile.mockReset();
  });

  describe('http(s) URLs', () => {
    it('fetches over http and returns the response body as ArrayBuffer', async () => {
      const expected = Buffer.from('hello').buffer;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(expected),
      } as unknown as Response);

      const result = await readSourceBytes('http://example.com/x.json');

      expect(fetch).toHaveBeenCalledWith('http://example.com/x.json');
      expect(result).toBe(expected);
      expect(readFile).not.toHaveBeenCalled();
    });

    it('fetches over https as well', async () => {
      const expected = new ArrayBuffer(0);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(expected),
      } as unknown as Response);

      await readSourceBytes('https://example.com/x.json');

      expect(fetch).toHaveBeenCalledWith('https://example.com/x.json');
    });

    it('throws NFError on non-ok response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as unknown as Response);

      await expect(readSourceBytes('http://bad.example/x.json')).rejects.toEqual(
        new NFError('503 - Service Unavailable')
      );
    });
  });

  describe('file URLs and paths', () => {
    it('reads a file:// URL via fs.readFile after converting to path', async () => {
      const payload = Buffer.from('{"a":1}');
      readFile.mockResolvedValue(payload);

      const result = await readSourceBytes('file:///tmp/x.json');

      expect(readFile).toHaveBeenCalledWith('/tmp/x.json');
      expect(new Uint8Array(result)).toEqual(new Uint8Array(payload));
    });

    it('reads a plain absolute path via fs.readFile', async () => {
      const payload = Buffer.from('content');
      readFile.mockResolvedValue(payload);

      const result = await readSourceBytes('/etc/hosts');

      expect(readFile).toHaveBeenCalledWith('/etc/hosts');
      expect(new Uint8Array(result)).toEqual(new Uint8Array(payload));
    });

    it('propagates fs errors', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      readFile.mockRejectedValue(err);

      await expect(readSourceBytes('/missing.json')).rejects.toThrow('ENOENT');
    });

    it('returns a true slice (not the underlying buffer) so callers cannot mutate the cache', async () => {
      const underlying = Buffer.alloc(32, 0xff);
      const slice = underlying.subarray(8, 16);
      readFile.mockResolvedValue(slice);

      const result = await readSourceBytes('/some/path');

      expect(result.byteLength).toBe(slice.byteLength);
      expect(new Uint8Array(result)).toEqual(new Uint8Array(slice));
    });
  });
});
