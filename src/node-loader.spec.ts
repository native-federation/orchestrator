/**
 * @jest-environment node
 */
import type { EventEmitter } from 'node:events';

type Handler = (msg: unknown) => void;

class FakePort {
  postMessage = jest.fn<void, [unknown]>();
  unref = jest.fn<void, []>();
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

const freshLoader = (): LoaderModule => {
  let mod!: LoaderModule;
  jest.isolateModules(() => {
    mod = require('./node-loader');
  });
  return mod;
};

describe('node-loader hooks', () => {
  describe('initialize', () => {
    it('is a no-op when called with no data', () => {
      const loader = freshLoader();
      expect(() => loader.initialize()).not.toThrow();
    });

    it('applies the initialImportMap before any messages arrive', async () => {
      const loader = freshLoader();
      loader.initialize({ initialImportMap: { imports: { foo: 'file:///foo.mjs' } } });
      const next = jest.fn().mockResolvedValue({ url: 'unused' });

      await loader.resolve('foo', {}, next);

      expect(next).toHaveBeenCalledWith('file:///foo.mjs', {});
    });

    it('subscribes to port messages and acks set-import-map', () => {
      const loader = freshLoader();
      const port = new FakePort();
      loader.initialize({ port: port as unknown as EventEmitter & { postMessage(m: unknown): void } });

      port.emit({ type: 'set-import-map', map: { imports: { bar: 'file:///bar.mjs' } } });

      expect(port.postMessage).toHaveBeenCalledWith({ type: 'import-map-applied' });
    });

    it('updates the active import map after a set-import-map message', async () => {
      const loader = freshLoader();
      const port = new FakePort();
      loader.initialize({ port: port as unknown as EventEmitter & { postMessage(m: unknown): void } });

      port.emit({ type: 'set-import-map', map: { imports: { live: 'file:///live.mjs' } } });

      const next = jest.fn().mockResolvedValue({ url: 'unused' });
      await loader.resolve('live', {}, next);
      expect(next).toHaveBeenCalledWith('file:///live.mjs', {});
    });

    it('ignores port messages of other types', async () => {
      const loader = freshLoader();
      const port = new FakePort();
      loader.initialize({ port: port as unknown as EventEmitter & { postMessage(m: unknown): void } });

      port.emit({ type: 'something-else' });
      port.emit(null);

      expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('unrefs the port if it supports it', () => {
      const loader = freshLoader();
      const port = new FakePort();
      loader.initialize({ port: port as unknown as EventEmitter & { postMessage(m: unknown): void } });
      expect(port.unref).toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    it('passes through unmapped specifiers', async () => {
      const loader = freshLoader();
      const next = jest.fn().mockResolvedValue({ url: 'next-out' });

      await loader.resolve('node:fs', {}, next);

      expect(next).toHaveBeenCalledWith('node:fs', {});
    });

    it('rewrites an exact match from imports', async () => {
      const loader = freshLoader();
      loader.initialize({
        initialImportMap: { imports: { foo: 'file:///pkg/foo.mjs' } },
      });
      const next = jest.fn().mockResolvedValue({ url: 'next-out' });

      await loader.resolve('foo', {}, next);

      expect(next).toHaveBeenCalledWith('file:///pkg/foo.mjs', {});
    });

    it('honours trailing-slash prefix imports', async () => {
      const loader = freshLoader();
      loader.initialize({
        initialImportMap: { imports: { 'pkg/': 'file:///pkg/' } },
      });
      const next = jest.fn().mockResolvedValue({ url: 'next-out' });

      await loader.resolve('pkg/sub/index.mjs', {}, next);

      expect(next).toHaveBeenCalledWith('file:///pkg/sub/index.mjs', {});
    });

    it('prefers a matching scope over the global imports', async () => {
      const loader = freshLoader();
      loader.initialize({
        initialImportMap: {
          imports: { lib: 'file:///globals/lib.mjs' },
          scopes: {
            'file:///apps/a/': { lib: 'file:///apps/a/lib.mjs' },
          },
        },
      });
      const next = jest.fn().mockResolvedValue({ url: 'next-out' });

      await loader.resolve('lib', { parentURL: 'file:///apps/a/entry.mjs' }, next);

      expect(next).toHaveBeenCalledWith('file:///apps/a/lib.mjs', {
        parentURL: 'file:///apps/a/entry.mjs',
      });
    });

    it('falls back to global imports when the scope does not match', async () => {
      const loader = freshLoader();
      loader.initialize({
        initialImportMap: {
          imports: { lib: 'file:///globals/lib.mjs' },
          scopes: {
            'file:///apps/a/': { lib: 'file:///apps/a/lib.mjs' },
          },
        },
      });
      const next = jest.fn().mockResolvedValue({ url: 'next-out' });

      await loader.resolve('lib', { parentURL: 'file:///apps/b/entry.mjs' }, next);

      expect(next).toHaveBeenCalledWith('file:///globals/lib.mjs', {
        parentURL: 'file:///apps/b/entry.mjs',
      });
    });
  });

  describe('load', () => {
    afterEach(() => {
      // restore any global fetch mock between tests
      // (each test sets its own)
    });

    it('short-circuits http URLs with the fetched source as ESM', async () => {
      const loader = freshLoader();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('export const x = 1;'),
      } as unknown as Response);
      const next = jest.fn();

      const result = await loader.load('http://example.com/m.mjs', {}, next);

      expect(fetch).toHaveBeenCalledWith('http://example.com/m.mjs');
      expect(result).toEqual({
        shortCircuit: true,
        format: 'module',
        source: 'export const x = 1;',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('short-circuits https URLs the same way', async () => {
      const loader = freshLoader();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('export {};'),
      } as unknown as Response);

      const result = await loader.load('https://example.com/m.mjs', {}, jest.fn());

      expect(result.format).toBe('module');
      expect(result.shortCircuit).toBe(true);
    });

    it('throws when the http fetch returns non-ok', async () => {
      const loader = freshLoader();
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Boom',
      } as unknown as Response);

      await expect(loader.load('http://example.com/m.mjs', {}, jest.fn())).rejects.toThrow(
        'Failed to fetch module from http://example.com/m.mjs: 500 Boom'
      );
    });

    it('sets context.format = "module" for non-node-non-http URLs and falls through', async () => {
      const loader = freshLoader();
      const ctx: { format?: string | null } = {};
      const next = jest.fn().mockResolvedValue({ url: 'x', format: 'module' });

      await loader.load('file:///foo.mjs', ctx, next);

      expect(ctx.format).toBe('module');
      expect(next).toHaveBeenCalledWith('file:///foo.mjs', ctx);
    });

    it('does not touch context.format for node: URLs', async () => {
      const loader = freshLoader();
      const ctx: { format?: string | null } = {};
      const next = jest.fn().mockResolvedValue({ url: 'node:fs', format: 'builtin' });

      await loader.load('node:fs', ctx, next);

      expect(ctx.format).toBeUndefined();
      expect(next).toHaveBeenCalledWith('node:fs', ctx);
    });
  });
});
