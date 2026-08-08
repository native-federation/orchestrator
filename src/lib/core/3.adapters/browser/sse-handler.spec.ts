import type { Mock, Mocked } from 'vitest';
vi.mock('@softarc/native-federation/domain', () => ({
  BuildNotificationType: {
    COMPLETED: 'federation-rebuild-complete',
    ERROR: 'federation-rebuild-error',
    CANCELLED: 'federation-rebuild-cancelled',
  },
}));

import { createSSEHandler } from './sse-handler';
import { ForSSE } from 'lib/core/2.app/driving-ports/for-sse.port';
import { BuildNotificationType } from '@softarc/native-federation/domain';
import { mockConfig } from 'lib/testing/config.mock';
import { ConfigContract } from 'lib/core/2.app/config/config.contract';

describe('createSSEHandler', () => {
  let sseHandler: ForSSE;
  let mockEventSource: Mocked<EventSource>;
  let config: ConfigContract;
  let eventSourceConstructorSpy: Mock;

  beforeEach(() => {
    // Mock EventSource
    mockEventSource = {
      onmessage: null,
      onerror: null,
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 2,
      readyState: 0,
      url: '',
      withCredentials: false,
      onopen: null,
    } as any;

    // Mock EventSource constructor on window (not global for jsdom).
    // vitest 4: a mock called with `new` needs a `function` (not arrow) implementation.
    (window as any).EventSource = vi.fn(function () {
      return mockEventSource;
    });
    eventSourceConstructorSpy = (window as any).EventSource;

    // Mock console methods
    config = mockConfig();

    sseHandler = createSSEHandler(config);
  });

  afterEach(() => {
    // Unbinds the window listeners; handlers left bound would react to later tests' events.
    sseHandler.closeAll();
    vi.restoreAllMocks();
    delete (window as any).EventSource;
  });

  describe('watchRemoteBuilds', () => {
    it('should create an EventSource with the provided endpoint', () => {
      const endpoint = 'https://example.com/sse-endpoint';

      sseHandler.watchRemoteBuilds(endpoint);

      expect(eventSourceConstructorSpy).toHaveBeenCalledWith(endpoint);
    });

    it('should reload the page when a COMPLETED build notification is received', () => {
      const endpoint = 'https://example.com/sse-endpoint';

      sseHandler.watchRemoteBuilds(endpoint);

      // Simulate an SSE message
      const event = {
        data: JSON.stringify({ type: BuildNotificationType.COMPLETED }),
      } as MessageEvent;

      mockEventSource.onmessage!(event);

      expect(config.log.debug).toHaveBeenCalledWith(0, '[SSE] Rebuild completed, reloading...');
      expect(config.reloadBrowserFn).toHaveBeenCalled();
    });

    it('should not reload the page when a non-COMPLETED build notification is received', () => {
      const endpoint = 'https://example.com/sse-endpoint';

      sseHandler.watchRemoteBuilds(endpoint);

      // Simulate an SSE message with a different type
      const event = {
        data: JSON.stringify({ type: 'STARTED' }),
      } as MessageEvent;

      mockEventSource.onmessage!(event);

      expect(config.reloadBrowserFn).not.toHaveBeenCalled();
    });

    it('should log a warning when an SSE error occurs', () => {
      const endpoint = 'https://example.com/sse-endpoint';

      sseHandler.watchRemoteBuilds(endpoint);

      // Simulate an error event
      const errorEvent = new Event('error');

      mockEventSource.onerror!(errorEvent);

      expect(config.log.error).toHaveBeenCalledWith(0, '[SSE] Connection error:', errorEvent);
    });

    it('should handle malformed JSON in SSE messages', () => {
      const endpoint = 'https://example.com/sse-endpoint';

      sseHandler.watchRemoteBuilds(endpoint);

      // Simulate an SSE message with malformed JSON
      const event = {
        data: 'invalid-json',
      } as MessageEvent;

      expect(() => mockEventSource.onmessage!(event)).toThrow();
    });

    it('should handle SSE messages with missing type field', () => {
      const endpoint = 'https://example.com/sse-endpoint';

      sseHandler.watchRemoteBuilds(endpoint);

      // Simulate an SSE message without a type field
      const event = {
        data: JSON.stringify({ someOtherField: 'value' }),
      } as MessageEvent;

      mockEventSource.onmessage!(event);

      expect(config.reloadBrowserFn).not.toHaveBeenCalled();
    });

    it('should create multiple EventSource instances when called multiple times', () => {
      const endpoint1 = 'https://example.com/sse-endpoint-1';
      const endpoint2 = 'https://example.com/sse-endpoint-2';

      sseHandler.watchRemoteBuilds(endpoint1);
      sseHandler.watchRemoteBuilds(endpoint2);

      expect(eventSourceConstructorSpy).toHaveBeenCalledTimes(2);
      expect(eventSourceConstructorSpy).toHaveBeenNthCalledWith(1, endpoint1);
      expect(eventSourceConstructorSpy).toHaveBeenNthCalledWith(2, endpoint2);
    });

    it('should handle SSE messages with additional data fields', () => {
      const endpoint = 'https://example.com/sse-endpoint';

      sseHandler.watchRemoteBuilds(endpoint);

      // Simulate an SSE message with additional fields
      const event = {
        data: JSON.stringify({
          type: BuildNotificationType.COMPLETED,
          timestamp: Date.now(),
          buildId: 'abc123',
        }),
      } as MessageEvent;

      mockEventSource.onmessage!(event);

      expect(config.log.debug).toHaveBeenCalledWith(0, '[SSE] Rebuild completed, reloading...');
      expect(config.reloadBrowserFn).toHaveBeenCalled();
    });

    it('should open only one EventSource per endpoint', () => {
      const endpoint = 'https://example.com/sse-endpoint';

      sseHandler.watchRemoteBuilds(endpoint);
      sseHandler.watchRemoteBuilds(endpoint);
      sseHandler.watchRemoteBuilds(endpoint);

      expect(eventSourceConstructorSpy).toHaveBeenCalledTimes(1);
      expect(config.log.debug).toHaveBeenCalledWith(0, `[SSE] Already watching '${endpoint}'`);
    });
  });

  describe('closeAll', () => {
    it('should close every open EventSource', () => {
      sseHandler.watchRemoteBuilds('https://example.com/a');
      sseHandler.watchRemoteBuilds('https://example.com/b');

      sseHandler.closeAll();

      expect(mockEventSource.close).toHaveBeenCalledTimes(2);
    });

    it('should allow an endpoint to be watched again afterwards', () => {
      const endpoint = 'https://example.com/sse-endpoint';

      sseHandler.watchRemoteBuilds(endpoint);
      sseHandler.closeAll();
      sseHandler.watchRemoteBuilds(endpoint);

      expect(eventSourceConstructorSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('back/forward cache', () => {
    // The handler reads `persisted` to tell a frozen page from an unloading one.
    function firePageEvent(type: 'pagehide' | 'pageshow', persisted: boolean) {
      const event = new Event(type);
      Object.defineProperty(event, 'persisted', { value: persisted });
      window.dispatchEvent(event);
    }

    it('should close the stream when the page is frozen into the cache', () => {
      sseHandler.watchRemoteBuilds('https://example.com/sse-endpoint');

      firePageEvent('pagehide', true);

      expect(mockEventSource.close).toHaveBeenCalledTimes(1);
    });

    it('should leave an unloading page alone', () => {
      sseHandler.watchRemoteBuilds('https://example.com/sse-endpoint');

      firePageEvent('pagehide', false);

      expect(mockEventSource.close).not.toHaveBeenCalled();
    });

    it('should reopen the stream when a cached page is restored', () => {
      const endpoint = 'https://example.com/sse-endpoint';
      sseHandler.watchRemoteBuilds(endpoint);

      firePageEvent('pagehide', true);
      firePageEvent('pageshow', true);

      expect(eventSourceConstructorSpy).toHaveBeenCalledTimes(2);
      expect(eventSourceConstructorSpy).toHaveBeenNthCalledWith(2, endpoint);
    });

    it('should not reopen a stream that was never watched', () => {
      firePageEvent('pageshow', true);

      expect(eventSourceConstructorSpy).not.toHaveBeenCalled();
    });
  });

  describe('leader election', () => {
    // Mirrors the constant in sse-handler.ts.
    const RELAY_CHANNEL = 'native-federation-sse';
    const endpoint = 'https://example.com/sse-endpoint';

    let pendingLocks: { name: string; grant: () => unknown }[];
    let leaderHandler: ForSSE;
    let probe: BroadcastChannel | undefined;

    // Stands in for navigator.locks, which jsdom does not implement. A request stays
    // queued until the test calls grant(), the way a lock held by another tab would.
    beforeEach(() => {
      pendingLocks = [];
      const locks = {
        request: vi.fn(
          (name: string, options: { signal: AbortSignal }, callback: () => unknown) => {
            pendingLocks.push({ name, grant: callback });
            return new Promise((_resolve, reject) => {
              options.signal.addEventListener('abort', () => reject(new Error('AbortError')));
            });
          }
        ),
        query: vi.fn(),
      };

      Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
      leaderHandler = createSSEHandler(config);
    });

    afterEach(() => {
      leaderHandler.closeAll();
      probe?.close();
      probe = undefined;
      delete (navigator as any).locks;
    });

    const tick = () => new Promise(resolve => setTimeout(resolve, 0));

    it('should request one lock per endpoint', () => {
      leaderHandler.watchRemoteBuilds(endpoint);
      leaderHandler.watchRemoteBuilds('https://example.com/other');

      expect(pendingLocks.map(lock => lock.name)).toEqual([
        `native-federation-sse:${endpoint}`,
        'native-federation-sse:https://example.com/other',
      ]);
    });

    it('should not open a stream while another tab holds the lock', () => {
      leaderHandler.watchRemoteBuilds(endpoint);

      expect(eventSourceConstructorSpy).not.toHaveBeenCalled();
    });

    it('should open the stream once the lock is granted', () => {
      leaderHandler.watchRemoteBuilds(endpoint);

      pendingLocks[0]!.grant();

      expect(eventSourceConstructorSpy).toHaveBeenCalledWith(endpoint);
      expect(config.log.debug).toHaveBeenCalledWith(
        0,
        `[SSE] Holding the connection for '${endpoint}'`
      );
    });

    it('should withdraw a queued lock request on closeAll', async () => {
      leaderHandler.watchRemoteBuilds(endpoint);

      leaderHandler.closeAll();
      await tick();

      expect(config.log.debug).toHaveBeenCalledWith(
        0,
        `[SSE] Released the connection for '${endpoint}'`
      );
    });

    it('should not open a stream for a lock granted after closeAll', () => {
      leaderHandler.watchRemoteBuilds(endpoint);
      leaderHandler.closeAll();

      pendingLocks[0]!.grant();

      expect(eventSourceConstructorSpy).not.toHaveBeenCalled();
    });

    it('should tell the other tabs to reload when the build completes', async () => {
      const received = vi.fn();
      probe = new BroadcastChannel(RELAY_CHANNEL);
      probe.onmessage = received;

      leaderHandler.watchRemoteBuilds(endpoint);
      pendingLocks[0]!.grant();

      mockEventSource.onmessage!({
        data: JSON.stringify({ type: BuildNotificationType.COMPLETED }),
      } as MessageEvent);
      await tick();

      expect(received).toHaveBeenCalledTimes(1);
      expect(received.mock.calls[0]![0].data).toEqual({ endpoint });
    });

    it('should reload when another tab reports a completed build', async () => {
      leaderHandler.watchRemoteBuilds(endpoint);

      probe = new BroadcastChannel(RELAY_CHANNEL);
      probe.postMessage({ endpoint });
      await tick();

      expect(config.log.debug).toHaveBeenCalledWith(
        0,
        '[SSE] Rebuild completed in another tab, reloading...'
      );
      expect(config.reloadBrowserFn).toHaveBeenCalled();
    });
  });
});
