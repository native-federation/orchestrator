import { createPreloadHint } from './preload-hint';
import { createMockLogHandler } from 'lib/testing/handlers/log.handler';

describe('createPreloadHint', () => {
  // ForBrowserTasks is public in /sdk; an adapter built before preloading existed has no preloadModules.
  it('does nothing, and collects nothing, for a browser adapter without preloadModules', () => {
    const log = createMockLogHandler('debug');
    const collect = vi.fn(() => ['http://r0/a.js']);

    createPreloadHint(log, {}, 6)(collect);

    expect(collect).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('calls preloadModules on the adapter, keeping its this', () => {
    const log = createMockLogHandler('debug');
    const adapter = {
      seen: [] as string[][],
      preloadModules(urls: string[]) {
        this.seen.push(urls);
      },
    };

    createPreloadHint(log, adapter, 6)(() => ['http://r0/a.js']);

    expect(adapter.seen).toEqual([['http://r0/a.js']]);
  });

  it('logs a rejecting async preloadModules at debug instead of leaving it unhandled', async () => {
    const log = createMockLogHandler('debug');
    const error = new Error('broken async host preload');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      createPreloadHint(
        log,
        { preloadModules: async () => Promise.reject(error) },
        6
      )(() => ['http://r0/a.js']);

      await vi.waitFor(() =>
        expect(log.debug).toHaveBeenCalledWith(6, 'Ignored a failing preload hint.', error)
      );
      await new Promise(r => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
