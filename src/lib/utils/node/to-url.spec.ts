/**
 * @jest-environment node
 */
import { pathToFileURL } from 'node:url';
import { toUrl, normalizeHostRemoteEntry } from './to-url';

describe('toUrl', () => {
  it.each([
    ['http://example.com/remoteEntry.json'],
    ['https://example.com/remoteEntry.json'],
    ['file:///tmp/remoteEntry.json'],
    ['node:fs'],
    ['data:application/json,{}'],
  ])('passes through anything with a URL scheme: %s', input => {
    expect(toUrl(input)).toBe(input);
  });

  it('converts an absolute filesystem path to a file:// URL', () => {
    const path = '/tmp/remoteEntry.json';

    const result = toUrl(path);

    expect(result).toBe(pathToFileURL(path).href);
    expect(result.startsWith('file://')).toBe(true);
  });

  it('converts a relative filesystem path to a file:// URL anchored at cwd', () => {
    const path = './local/remoteEntry.json';

    const result = toUrl(path);

    expect(result).toBe(pathToFileURL(path).href);
    expect(result.startsWith('file://')).toBe(true);
  });

  it('treats schemes case-insensitively (HTTPS, FILE, etc.)', () => {
    expect(toUrl('HTTPS://example.com/x.json')).toBe('HTTPS://example.com/x.json');
    expect(toUrl('FILE:///tmp/x.json')).toBe('FILE:///tmp/x.json');
  });
});

describe('normalizeHostRemoteEntry', () => {
  it('returns false unchanged', () => {
    expect(normalizeHostRemoteEntry(false)).toBe(false);
  });

  it('returns undefined unchanged', () => {
    expect(normalizeHostRemoteEntry(undefined)).toBeUndefined();
  });

  describe('when input is a string', () => {
    it('passes through an http URL', () => {
      expect(normalizeHostRemoteEntry('http://x/remoteEntry.json')).toBe(
        'http://x/remoteEntry.json'
      );
    });

    it('converts a filesystem path to a file:// URL', () => {
      const result = normalizeHostRemoteEntry('/tmp/remoteEntry.json') as string;

      expect(result).toBe(pathToFileURL('/tmp/remoteEntry.json').href);
    });
  });

  describe('when input is an object', () => {
    it('passes through the url when it already has a scheme', () => {
      const input = { url: 'http://x/remoteEntry.json' };

      expect(normalizeHostRemoteEntry(input)).toEqual({ url: 'http://x/remoteEntry.json' });
    });

    it('converts a path-shaped url field to a file:// URL', () => {
      const input = { url: '/tmp/remoteEntry.json' };

      const result = normalizeHostRemoteEntry(input) as { url: string };

      expect(result.url).toBe(pathToFileURL('/tmp/remoteEntry.json').href);
    });

    it('preserves the other fields on the object', () => {
      const input = {
        name: 'host',
        url: '/tmp/remoteEntry.json',
        cacheTag: 'v1',
        integrity: 'sha384-abc',
      };

      const result = normalizeHostRemoteEntry(input) as typeof input;

      expect(result).toEqual({
        name: 'host',
        url: pathToFileURL('/tmp/remoteEntry.json').href,
        cacheTag: 'v1',
        integrity: 'sha384-abc',
      });
    });

    it('does not mutate the input object', () => {
      const input = { url: '/tmp/remoteEntry.json', name: 'host' };
      const snapshot = { ...input };

      normalizeHostRemoteEntry(input);

      expect(input).toEqual(snapshot);
    });
  });
});
