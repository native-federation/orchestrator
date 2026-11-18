/**
 * @vitest-environment node
 */
import type { EventEmitter } from 'node:events';

type Handler = (msg: unknown) => void;

class FakePort {
  postMessage = vi.fn<(msg: unknown) => void>();
  unref = vi.fn<() => void>();
  private handlers: Handler[] = [];
  on(_event: 'message', fn: Handler): this {
    this.handlers.push(fn);
    return this;
  }
  emit(msg: unknown): void {
    [...this.handlers].forEach(h => h(msg));
  }
}

type LoaderModule = typeof import('./node-loader');

const freshLoader = async (): Promise<LoaderModule> => {
  vi.resetModules();
  return import('./node-loader');
};

describe('node-loader hooks', () => {
  describe('initialize', () => {
    it('is a no-op when called with no data', async () => {
      const loader = await freshLoader();
      expect(() => loader.initialize()).not.toThrow();
    });

    it('applies the initialImportMap before any messages arrive', async () => {
      const loader = await freshLoader();
      loader.initialize({ initialImportMap: { imports: { foo: 'file:///foo.mjs' } } });
      const next = vi.fn().mockResolvedValue({ url: 'unused' });

      await loader.resolve('foo', {}, next);

      expect(next).toHaveBeenCalledWith('file:///foo.mjs', {});
    });

    it('subscribes to port messages and acks set-import-map', async () => {
      const loader = await freshLoader();
      const port = new FakePort();
      loader.initialize({
        port: port as unknown as EventEmitter & { postMessage(m: unknown): void },
      });

      port.emit({ type: 'set-import-map', map: { imports: { bar: 'file:///bar.mjs' } } });

      expect(port.postMessage).toHaveBeenCalledWith({ type: 'import-map-applied' });
    });

    it('updates the active import map after a set-import-map message', async () => {
      const loader = await freshLoader();
      const port = new FakePort();
      loader.initialize({
        port: port as unknown as EventEmitter & { postMessage(m: unknown): void },
      });

      port.emit({ type: 'set-import-map', map: { imports: { live: 'file:///live.mjs' } } });

      const next = vi.fn().mockResolvedValue({ url: 'unused' });
      await loader.resolve('live', {}, next);
      expect(next).toHaveBeenCalledWith('file:///live.mjs', {});
    });

    it('acks set-host-instances with host-instances-applied', async () => {
      const loader = await freshLoader();
      const port = new FakePort();
      loader.initialize({
        port: port as unknown as EventEmitter & { postMessage(m: unknown): void },
      });

      port.emit({ type: 'set-host-instances', keys: { '@angular/core': ['Component'] } });

      expect(port.postMessage).toHaveBeenCalledWith({ type: 'host-instances-applied' });
    });

    it('ignores port messages of other types', async () => {
      const loader = await freshLoader();
      const port = new FakePort();
      loader.initialize({
        port: port as unknown as EventEmitter & { postMessage(m: unknown): void },
      });

      port.emit({ type: 'something-else' });
      port.emit(null);

      expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('unrefs the port if it supports it', async () => {
      const loader = await freshLoader();
      const port = new FakePort();
      loader.initialize({
        port: port as unknown as EventEmitter & { postMessage(m: unknown): void },
      });
      expect(port.unref).toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    it('passes through unmapped specifiers', async () => {
      const loader = await freshLoader();
      const next = vi.fn().mockResolvedValue({ url: 'next-out' });

      await loader.resolve('node:fs', {}, next);

      expect(next).toHaveBeenCalledWith('node:fs', {});
    });

    it('rewrites an exact match from imports', async () => {
      const loader = await freshLoader();
      loader.initialize({
        initialImportMap: { imports: { foo: 'file:///pkg/foo.mjs' } },
      });
      const next = vi.fn().mockResolvedValue({ url: 'next-out' });

      await loader.resolve('foo', {}, next);

      expect(next).toHaveBeenCalledWith('file:///pkg/foo.mjs', {});
    });

    it('honours trailing-slash prefix imports', async () => {
      const loader = await freshLoader();
      loader.initialize({
        initialImportMap: { imports: { 'pkg/': 'file:///pkg/' } },
      });
      const next = vi.fn().mockResolvedValue({ url: 'next-out' });

      await loader.resolve('pkg/sub/index.mjs', {}, next);

      expect(next).toHaveBeenCalledWith('file:///pkg/sub/index.mjs', {});
    });

    it('prefers a matching scope over the global imports', async () => {
      const loader = await freshLoader();
      loader.initialize({
        initialImportMap: {
          imports: { lib: 'file:///globals/lib.mjs' },
          scopes: {
            'file:///apps/a/': { lib: 'file:///apps/a/lib.mjs' },
          },
        },
      });
      const next = vi.fn().mockResolvedValue({ url: 'next-out' });

      await loader.resolve('lib', { parentURL: 'file:///apps/a/entry.mjs' }, next);

      expect(next).toHaveBeenCalledWith('file:///apps/a/lib.mjs', {
        parentURL: 'file:///apps/a/entry.mjs',
      });
    });

    it('falls back to global imports when the scope does not match', async () => {
      const loader = await freshLoader();
      loader.initialize({
        initialImportMap: {
          imports: { lib: 'file:///globals/lib.mjs' },
          scopes: {
            'file:///apps/a/': { lib: 'file:///apps/a/lib.mjs' },
          },
        },
      });
      const next = vi.fn().mockResolvedValue({ url: 'next-out' });

      await loader.resolve('lib', { parentURL: 'file:///apps/b/entry.mjs' }, next);

      expect(next).toHaveBeenCalledWith('file:///globals/lib.mjs', {
        parentURL: 'file:///apps/b/entry.mjs',
      });
    });

    it('short-circuits an http(s) mapped specifier instead of handing it to nextResolve', async () => {
      const loader = await freshLoader();
      loader.initialize({
        initialImportMap: { imports: { remote: 'https://host/remote/remoteEntry.mjs' } },
      });
      const next = vi.fn();

      const result = await loader.resolve('remote', {}, next);

      expect(result).toEqual({
        url: 'https://host/remote/remoteEntry.mjs',
        format: 'module',
        shortCircuit: true,
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('resolves a relative sibling-chunk specifier against parentURL without an import-map entry', async () => {
      const loader = await freshLoader();
      const next = vi.fn();

      const result = await loader.resolve(
        './chunk-abc.js',
        { parentURL: 'https://host/remote/entry.js' },
        next
      );

      expect(result).toEqual({
        url: 'https://host/remote/chunk-abc.js',
        format: 'module',
        shortCircuit: true,
      });
      expect(next).not.toHaveBeenCalled();
    });

    // #130: the parent used to fall back to the last fetched remote, so a vm script's relative
    // import (parentURL undefined) landed on whichever remote loaded last. Node resolves it
    // against cwd instead, so it must reach nextResolve untouched.
    it.each([
      ['undefined', undefined],
      ['empty', ''],
    ])(
      'leaves a relative import to Node when parentURL is %s, even after a remote loaded',
      async (_, parentURL) => {
        const loader = await freshLoader();
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve('export {};'),
        } as unknown as Response);
        await loader.load('https://host/remote/entry.js', {}, vi.fn());
        const resolved = { url: 'file:///cwd/chunk-abc.js' };
        const next = vi.fn().mockResolvedValue(resolved);

        const result = await loader.resolve('./chunk-abc.js', { parentURL }, next);

        expect(next).toHaveBeenCalledWith('./chunk-abc.js', { parentURL });
        expect(result).toBe(resolved);
      }
    );
  });

  describe('unresolvable specifiers', () => {
    const invalidURL = Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' });

    it('names the specifier and parent when a bare import from an http module is not mapped', async () => {
      const loader = await freshLoader();
      const next = vi.fn().mockRejectedValue(invalidURL);

      await expect(
        loader.resolve('zone.js/plugins/task-tracking', { parentURL: 'https://host/core.js' }, next)
      ).rejects.toThrow(
        "Unable to resolve 'zone.js/plugins/task-tracking' imported from https://host/core.js: not in the import map"
      );
    });

    it("rethrows nextResolve's error for a file:// parent", async () => {
      const loader = await freshLoader();
      const next = vi.fn().mockRejectedValue(invalidURL);

      await expect(loader.resolve('pkg', { parentURL: 'file:///app/main.mjs' }, next)).rejects.toBe(
        invalidURL
      );
    });

    it('rethrows other errors from an http parent unchanged', async () => {
      const loader = await freshLoader();
      const notFound = Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' });
      const next = vi.fn().mockRejectedValue(notFound);

      await expect(loader.resolve('pkg', { parentURL: 'https://host/a.js' }, next)).rejects.toBe(
        notFound
      );
    });
  });

  // #79: only federated file:// modules are forced to ESM; host dependencies keep Node's format.
  describe('module format', () => {
    it('marks an import-map target as ESM', async () => {
      const loader = await freshLoader();
      loader.initialize({ initialImportMap: { imports: { rxjs: 'file:///dist/rxjs.js' } } });
      const next = vi.fn().mockResolvedValue({ url: 'file:///dist/rxjs.js', format: 'commonjs' });

      const result = await loader.resolve('rxjs', {}, next);

      expect(result).toEqual({ url: 'file:///dist/rxjs.js', format: 'module' });
    });

    it('marks a relative chunk of a federated module as ESM', async () => {
      const loader = await freshLoader();
      loader.initialize({ initialImportMap: { imports: { mfe: 'file:///dist/mfe/entry.js' } } });
      await loader.resolve(
        'mfe',
        {},
        vi.fn().mockResolvedValue({ url: 'file:///dist/mfe/entry.js' })
      );
      const next = vi.fn().mockResolvedValue({ url: 'file:///dist/mfe/chunk-a.js', format: null });

      const result = await loader.resolve(
        './chunk-a.js',
        { parentURL: 'file:///dist/mfe/entry.js' },
        next
      );

      expect(result).toEqual({ url: 'file:///dist/mfe/chunk-a.js', format: 'module' });
    });

    it('marks a map target imported by its URL as ESM, even when Node resolves it elsewhere', async () => {
      const loader = await freshLoader();
      loader.initialize({
        initialImportMap: { imports: { 'mfe/./List': 'file:///deploy/mfe/List.js' } },
      });
      // nextResolve returns the realpath of a symlinked deploy dir.
      const next = vi
        .fn()
        .mockResolvedValue({ url: 'file:///releases/7/mfe/List.js', format: null });

      const result = await loader.resolve('file:///deploy/mfe/List.js', {}, next);

      expect(result).toEqual({ url: 'file:///releases/7/mfe/List.js', format: 'module' });
    });

    it('marks a map target imported relatively from a non-federated parent as ESM', async () => {
      const loader = await freshLoader();
      loader.initialize({
        initialImportMap: { imports: { 'mfe/./List': 'file:///app/dist/mfe/List.js' } },
      });
      const next = vi.fn().mockResolvedValue({ url: 'file:///app/dist/mfe/List.js', format: null });

      const result = await loader.resolve(
        './dist/mfe/List.js',
        { parentURL: 'file:///app/server.mjs' },
        next
      );

      expect(result).toEqual({ url: 'file:///app/dist/mfe/List.js', format: 'module' });
    });

    it("keeps nextResolve's format for an unmapped bare specifier", async () => {
      const loader = await freshLoader();
      const resolved = { url: 'file:///node_modules/rxjs/dist/cjs/index.js', format: 'commonjs' };
      const next = vi.fn().mockResolvedValue(resolved);

      await expect(loader.resolve('rxjs', {}, next)).resolves.toBe(resolved);
    });

    it("keeps nextResolve's format for a relative import from a non-federated parent", async () => {
      const loader = await freshLoader();
      const resolved = { url: 'file:///node_modules/pkg/util.js', format: 'commonjs' };
      const next = vi.fn().mockResolvedValue(resolved);

      await expect(
        loader.resolve('./util.js', { parentURL: 'file:///node_modules/pkg/index.mjs' }, next)
      ).resolves.toBe(resolved);
    });
  });

  describe('host instances', () => {
    const withHostInstances = async (keys: Record<string, string[]>): Promise<LoaderModule> => {
      const loader = await freshLoader();
      const port = new FakePort();
      loader.initialize({
        port: port as unknown as EventEmitter & { postMessage(m: unknown): void },
      });
      port.emit({ type: 'set-host-instances', keys });
      return loader;
    };

    it('routes a bridged specifier to a synthetic nf-host: URL, bypassing nextResolve', async () => {
      const loader = await withHostInstances({ '@angular/core': ['Component'] });
      const next = vi.fn();

      const result = await loader.resolve('@angular/core', {}, next);

      expect(result).toEqual({ url: 'nf-host:%40angular%2Fcore', shortCircuit: true });
      expect(next).not.toHaveBeenCalled();
    });

    it('bridged specifiers win over the import map', async () => {
      const loader = await freshLoader();
      const port = new FakePort();
      loader.initialize({
        port: port as unknown as EventEmitter & { postMessage(m: unknown): void },
      });
      port.emit({
        type: 'set-import-map',
        map: { imports: { '@angular/core': 'file:///ng.mjs' } },
      });
      port.emit({ type: 'set-host-instances', keys: { '@angular/core': ['Component'] } });
      const next = vi.fn();

      const result = await loader.resolve('@angular/core', {}, next);

      expect(result.url).toBe('nf-host:%40angular%2Fcore');
      expect(next).not.toHaveBeenCalled();
    });

    it('synthesizes a module that re-exports named keys and default from the host instances', async () => {
      const loader = await withHostInstances({
        '@angular/core': ['Component', 'default', 'ɵsetClassMetadata'],
      });

      const result = await loader.load('nf-host:%40angular%2Fcore', {}, vi.fn());

      expect(result.shortCircuit).toBe(true);
      expect(result.format).toBe('module');
      const source = result.source as string;
      expect(source).toContain('globalThis["__NF_HOST_INSTANCES__"]["@angular/core"]');
      expect(source).toContain('export const Component = __ns["Component"];');
      expect(source).toContain('export const ɵsetClassMetadata = __ns["ɵsetClassMetadata"];');
      expect(source).toContain('export default __ns["default"];');
      // `default` must not also be emitted as a named const.
      expect(source).not.toContain('export const default');
    });

    it('throws a clear error at eval time when the namespace is not published', async () => {
      const loader = await withHostInstances({ '@angular/core': ['Component'] });
      const result = await loader.load('nf-host:%40angular%2Fcore', {}, vi.fn());
      const source = result.source as string;

      expect(source).toContain(
        `throw new Error("[native-federation] host instance '@angular/core' not published")`
      );
    });

    it('skips export names that are not valid identifiers', async () => {
      const loader = await withHostInstances({ pkg: ['ok', 'has-dash', '1bad'] });

      const result = await loader.load('nf-host:pkg', {}, vi.fn());
      const source = result.source as string;

      expect(source).toContain('export const ok = __ns["ok"];');
      expect(source).not.toContain('has-dash');
      expect(source).not.toContain('1bad');
    });
  });

  describe('load', () => {
    afterEach(() => {
      // restore any global fetch mock between tests
      // (each test sets its own)
    });

    it('short-circuits http URLs with the fetched source as ESM', async () => {
      const loader = await freshLoader();
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('export const x = 1;'),
      } as unknown as Response);
      const next = vi.fn();

      const result = await loader.load('http://example.com/m.mjs', {}, next);

      expect(fetch).toHaveBeenCalledWith('http://example.com/m.mjs', {
        signal: expect.any(AbortSignal),
      });
      expect(result).toEqual({
        shortCircuit: true,
        format: 'module',
        source: 'export const x = 1;',
        responseURL: 'http://example.com/m.mjs',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('short-circuits https URLs the same way', async () => {
      const loader = await freshLoader();
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('export {};'),
      } as unknown as Response);

      const result = await loader.load('https://example.com/m.mjs', {}, vi.fn());

      expect(result.format).toBe('module');
      expect(result.shortCircuit).toBe(true);
    });

    it('throws when the http fetch returns non-ok', async () => {
      const loader = await freshLoader();
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Boom',
      } as unknown as Response);

      await expect(loader.load('http://example.com/m.mjs', {}, vi.fn())).rejects.toThrow(
        'Failed to fetch module from http://example.com/m.mjs: 500 Boom'
      );
    });

    // A DOMException thrown in the hooks thread reaches the main thread as an Error with no
    // message, so the loader rethrows a plain Error that names the URL.
    it('names the URL and the timeout when the fetch times out', async () => {
      const loader = await freshLoader();
      loader.initialize({ fetchTimeoutMs: 250 });
      global.fetch = vi
        .fn()
        .mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

      await expect(loader.load('http://example.com/m.mjs', {}, vi.fn())).rejects.toThrow(
        'Failed to fetch module from http://example.com/m.mjs: no response within 250 ms (if this URL is served by the same Node process, it can never answer)'
      );
    });

    it('names the URL when the fetch fails otherwise', async () => {
      const loader = await freshLoader();
      global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

      await expect(loader.load('http://example.com/m.mjs', {}, vi.fn())).rejects.toThrow(
        'Failed to fetch module from http://example.com/m.mjs: fetch failed'
      );
    });

    // #79: forcing ESM on every file:// URL broke npm packages that resolve to CJS (rxjs 7).
    it('leaves context.format to Node for file URLs', async () => {
      const loader = await freshLoader();
      const ctx: { format?: string | null } = {};
      const next = vi.fn().mockResolvedValue({ url: 'x', format: 'commonjs' });

      await loader.load('file:///node_modules/rxjs/dist/cjs/index.js', ctx, next);

      expect(ctx.format).toBeUndefined();
      expect(next).toHaveBeenCalledWith('file:///node_modules/rxjs/dist/cjs/index.js', ctx);
    });

    it('does not touch context.format for node: URLs', async () => {
      const loader = await freshLoader();
      const ctx: { format?: string | null } = {};
      const next = vi.fn().mockResolvedValue({ url: 'node:fs', format: 'builtin' });

      await loader.load('node:fs', ctx, next);

      expect(ctx.format).toBeUndefined();
      expect(next).toHaveBeenCalledWith('node:fs', ctx);
    });
  });
});
