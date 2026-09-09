import { createSSEHandler } from 'lib/core/3.adapters/browser/sse-handler';
import type { ForSSE } from 'lib/core/2.app/driving-ports/for-sse.port';

/**
 * Runs in the page. Nothing here substitutes for a part of the adapter: it runs against the
 * browser's real `navigator.locks`, `BroadcastChannel` and `EventSource`. Only `reloadBrowserFn`
 * is stubbed, and only so that a reload is countable instead of wiping the page that counts it.
 */

const reloads: string[] = [];
const debugs: string[] = [];

let handler: ForSSE | undefined;

const api = {
  /**
   * `real: true` wires the library's own reload (`window.location.reload`) instead of the counting
   * stub, so a test can check what survives the leader navigating away in the same turn.
   */
  create: (real = false) => {
    handler = createSSEHandler({
      log: {
        level: 'debug',
        debug: (_step: number, msg: string) => debugs.push(msg),
        warn: () => undefined,
        error: () => undefined,
      },
      sse: true,
      reloadBrowserFn: real
        ? () => window.location.reload()
        : () => reloads.push(new Date().toISOString()),
      loadModuleFn: () => Promise.resolve({}),
      setImportMapFn: map => Promise.resolve(map),
    });
  },

  watch: (endpoint: string) => handler!.watchRemoteBuilds(endpoint),
  closeAll: () => handler!.closeAll(),
  reloads: () => reloads.length,

  /** Whether this tab won the election. The adapter announces it and nothing else does. */
  holding: () => debugs.some(msg => msg.startsWith('[SSE] Holding the connection')),
};

(globalThis as unknown as { __sse: typeof api }).__sse = api;

export type SseApi = typeof api;
