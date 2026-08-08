import { BuildNotificationType } from '@softarc/native-federation/domain';
import type { ImportMapConfig } from 'lib/core/2.app/config/import-map.contract';
import type { ForSSE } from 'lib/core/2.app/driving-ports/for-sse.port';
import type { LoggingConfig } from 'lib/core/2.app/config/log.contract';

const RELAY_CHANNEL = 'native-federation-sse';
const LOCK_PREFIX = 'native-federation-sse:';

type Subscription = {
  source?: EventSource;
  abort?: AbortController;
  releaseLock?: () => void;
};

/**
 * Watches for federation build completion events and automatically reloads the page.
 *
 * This function establishes a Server-Sent Events (SSE) connection to listen for
 * 'federation-rebuild-complete' notifications. When a build completes successfully,
 * it triggers a page reload to reflect the latest changes.
 * @param endpoint - The SSE endpoint URL to watch for build notifications.
 */
const createSSEHandler = (config: ImportMapConfig & LoggingConfig): ForSSE => {
  const subscriptions = new Map<string, Subscription>();

  // The per-origin connection cap is browser-global rather than per-tab, so one stream
  // per tab starves the origin of every other request. A Web Lock elects a single tab to
  // hold the stream; the others are told to reload over the relay.
  const locks: LockManager | undefined =
    typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const canRelay = !!locks && typeof BroadcastChannel !== 'undefined';

  let relay: BroadcastChannel | undefined;
  let bound = false;

  function reload(reason: string): void {
    config.log.debug(0, `[SSE] ${reason}, reloading...`);
    config.reloadBrowserFn();
  }

  function openEventSource(endpoint: string): EventSource {
    const eventSource = new EventSource(endpoint);

    eventSource.onmessage = function (event) {
      const data = JSON.parse(event.data);
      if (data.type === BuildNotificationType.COMPLETED) {
        relay?.postMessage({ endpoint });
        reload('Rebuild completed');
      }
    };

    eventSource.onerror = function (event) {
      config.log.error(0, '[SSE] Connection error:', event);
    };

    return eventSource;
  }

  function connect(endpoint: string, subscription: Subscription): void {
    if (!locks) {
      subscription.source = openEventSource(endpoint);
      return;
    }

    const abort = new AbortController();
    const held = new Promise<void>(resolve => {
      subscription.releaseLock = resolve;
    });
    subscription.abort = abort;

    locks
      .request(`${LOCK_PREFIX}${endpoint}`, { signal: abort.signal }, () => {
        if (abort.signal.aborted) return;

        config.log.debug(0, `[SSE] Holding the connection for '${endpoint}'`);
        subscription.source = openEventSource(endpoint);
        return held;
      })
      .catch(() => {
        config.log.debug(0, `[SSE] Released the connection for '${endpoint}'`);
      });
  }

  // `abort` only withdraws a request still queued; `releaseLock` is what hands back one
  // already granted. Which of the two applies is not observable from here.
  function disconnect(subscription: Subscription): void {
    subscription.source?.close();
    subscription.abort?.abort();
    subscription.releaseLock?.();
    subscription.source = undefined;
    subscription.abort = undefined;
    subscription.releaseLock = undefined;
  }

  function onPageHide(event: PageTransitionEvent): void {
    // Only a persisted page keeps its stream open; an unloading one is torn down for us.
    if (event.persisted) subscriptions.forEach(disconnect);
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted)
      subscriptions.forEach((subscription, endpoint) => connect(endpoint, subscription));
  }

  // Bound on first use rather than at construction: this adapter is built for every app,
  // including the ones that never enable SSE.
  function bind(): void {
    if (bound) return;
    bound = true;

    if (canRelay) {
      relay = new BroadcastChannel(RELAY_CHANNEL);
      relay.onmessage = () => reload('Rebuild completed in another tab');
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', onPageHide);
      window.addEventListener('pageshow', onPageShow);
    }
  }

  function unbind(): void {
    if (!bound) return;
    bound = false;

    relay?.close();
    relay = undefined;

    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    }
  }

  return {
    watchRemoteBuilds: function (endpoint: string) {
      if (subscriptions.has(endpoint)) {
        config.log.debug(0, `[SSE] Already watching '${endpoint}'`);
        return;
      }

      bind();

      const subscription: Subscription = {};
      subscriptions.set(endpoint, subscription);
      connect(endpoint, subscription);
    },

    closeAll: function () {
      subscriptions.forEach(disconnect);
      subscriptions.clear();
      unbind();
    },
  };
};

export { createSSEHandler };
