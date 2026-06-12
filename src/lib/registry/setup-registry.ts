import type {
  NFEventConsumer,
  NFEventData,
  NFEventProvider,
  NFEventUnsubscribe,
} from './event.contract';
import type { ForManagingEvents } from './for-managing-events.port';
import type { NFEventRegistryConfig, NFEventRegistryOptions } from './registry.contract';
import { cloneEntry } from 'lib/utils/clone-entry';

export function createRegistry(opts: NFEventRegistryOptions): ForManagingEvents {
  const cfg: NFEventRegistryConfig = {
    maxStreams: opts.maxStreams,
    maxEvents: opts.maxEvents ?? 1,
    removePercentage: opts.removePercentage,
  };

  // resources
  const resources = new Map<string, unknown>();
  const pending = new Map<string, Set<NFEventConsumer<any>>>();

  // events
  const events = new Map<string, NFEventData[]>();
  const listeners = new Map<string, Set<NFEventConsumer<NFEventData<any>>>>();
  const recentlyUsedStreams = new Set<string>();

  // Clamp to (maxEvents - 1) so at least one event always survives the trim.
  // Without this, maxEvents=1 (or any config where REMOVE_EVENTS == maxEvents)
  // would compute slice(-0), which returns the whole array and never trims.
  const REMOVE_EVENTS = Math.min(
    cfg.maxEvents - 1,
    cfg.removePercentage ? Math.ceil(cfg.maxEvents * cfg.removePercentage) : 1
  );

  /**
   * Mark `type` as the most-recently-used stream. When `maxStreams` is set and
   * the LRU set grows past that bound, the oldest stream (and its history) is
   * dropped. No-op when `maxStreams` is undefined — streams are then unbounded.
   */
  const touchStream = (type: string): void => {
    if (!cfg.maxStreams) return;
    recentlyUsedStreams.delete(type);
    recentlyUsedStreams.add(type);

    if (recentlyUsedStreams.size > cfg.maxStreams) {
      const oldest = recentlyUsedStreams.values().next().value;
      if (oldest) {
        recentlyUsedStreams.delete(oldest);
        events.delete(oldest);
      }
    }
  };

  /**
   * Append an event to `type`'s history, trim the history if it exceeds
   * `maxEvents`, and synchronously notify all current listeners. Trimming is
   * batched: when the history overflows, it is sliced down to
   * `(maxEvents - REMOVE_EVENTS)` items so subsequent emits don't slice on
   * every call.
   */
  const appendAndNotify = <T>(type: string, event: NFEventData<T>): void => {
    let history = events.get(type) ?? [];
    history.push(event);

    if (history.length > cfg.maxEvents) {
      history = history.slice(-(cfg.maxEvents - REMOVE_EVENTS));
    }

    events.set(type, history);

    const typeListeners = listeners.get(type);
    if (typeListeners && typeListeners.size > 0) {
      typeListeners.forEach(listener => listener(event));
    }
  };

  /**
   * RESOURCE: Register a resource by name. If the resource is a provider function, it is
   * invoked to obtain the actual resource. All callbacks waiting for this
   * resource via `onReady` are invoked once the resource is registered.
   */
  const register = async <T>(type: string, resource: T | NFEventProvider<T>): Promise<void> => {
    const value =
      typeof resource === 'function' ? await (resource as NFEventProvider<T>)() : resource;

    resources.set(type, value);

    const callbacks = pending.get(type);
    if (callbacks) {
      pending.delete(type);
      callbacks.forEach(cb => cb(value));
    }
  };

  /**
   * RESOURCE: Subscribe to the readiness of a resource. If the resource is already
   * registered, the callback is invoked immediately. Otherwise, the callback
   * is invoked once the resource is registered.
   */
  const onReady = <T>(type: string, callback: NFEventConsumer<T>): NFEventUnsubscribe => {
    const existing = resources.get(type);
    if (existing !== undefined) {
      callback(existing as T);
      return () => {};
    }

    let callbacks = pending.get(type);
    if (!callbacks) {
      callbacks = new Set();
      pending.set(type, callbacks);
    }
    callbacks.add(callback);

    return () => {
      callbacks!.delete(callback);
      if (callbacks!.size === 0) {
        pending.delete(type);
      }
    };
  };

  /**
   * EVENT: Subscribe to events of a specific type. The callback is invoked for
   * all future events of that type, and — when `opts.replay > 0` — for the
   * most recent `opts.replay` events already in history. Replay deliveries are
   * scheduled via `queueMicrotask`, so the unsubscribe handle is returned
   * synchronously and the callback fires after the current task completes.
   *
   * @param type        Stream identifier.
   * @param callback    Listener invoked with each event (replay + future).
   * @param opts.replay Number of buffered events to replay on subscribe, taken
   *                    from the tail of history (most recent first, delivered
   *                    in chronological order). Defaults to `1`, matching the
   *                    BehaviorSubject pattern: a fresh subscriber receives
   *                    the latest state. Pass `0` to suppress replay; pass a
   *                    larger value (capped by `maxEvents`) to receive more
   *                    history.
   * @returns           Function that unsubscribes the listener.
   */
  const on = <T>(
    type: string,
    callback: NFEventConsumer<NFEventData<T>>,
    opts: { replay?: number } = {}
  ): NFEventUnsubscribe => {
    const replay = opts.replay ?? 1;
    const history = events.get(type);

    let typeListeners = listeners.get(type);
    if (!typeListeners) {
      typeListeners = new Set();
      listeners.set(type, typeListeners);
    }
    typeListeners.add(callback);

    if (history && history.length > 0 && replay > 0) {
      queueMicrotask(() => {
        const start = Math.max(0, history.length - replay);
        for (let i = start; i < history.length; i++) {
          callback(cloneEntry('event channel ' + type, history[i]!));
        }
      });
    }

    return () => {
      typeListeners!.delete(callback);
      if (typeListeners!.size === 0) {
        listeners.delete(type);
      }
    };
  };

  /**
   * EVENT: Publish a new event on `type`. The event is appended to the stream's
   * history and delivered synchronously to every current listener. When
   * `maxEvents` is exceeded the history is batch-trimmed; when `maxStreams` is
   * set, emitting to a new type may evict the least-recently-used stream.
   */
  const emit = <T>(type: string, data: T): void => {
    touchStream(type);
    appendAndNotify(type, { data, timestamp: Date.now() });
  };

  /**
   * EVENT: Publish a new event on `type` derived from the previous value, in
   * the style of a state reducer. `updateFn` receives a structured clone of
   * the last event's data (or `undefined` if the stream is empty), and its
   * return value becomes the next event. The clone protects historical events
   * from accidental mutation inside `updateFn`.
   *
   * Use this instead of `emit` when the new state depends on the old one — it
   * collapses the read-modify-write into a single, race-free call. Requires
   * `data` to be structured-clone-able when the stream is non-empty.
   *
   * @param type     Stream identifier.
   * @param updateFn Reducer: `(current | undefined) => next`. Called with a
   *                 cloned snapshot of the last value (or `undefined` on
   *                 first emit).
   */
  const update = <T>(type: string, updateFn: (current: T | undefined) => T): void => {
    touchStream(type);

    const history = events.get(type) ?? [];
    const lastEvent = history[history.length - 1];
    const current =
      lastEvent === undefined ? undefined : cloneEntry('event channel ' + type, lastEvent.data);

    appendAndNotify(type, {
      data: updateFn(current),
      timestamp: Date.now(),
    });
  };

  const clear = (type?: string): void => {
    if (type) {
      // Clear event-related data
      events.delete(type);
      listeners.delete(type);

      // Clear resource-related data
      resources.delete(type);
      pending.delete(type);

      recentlyUsedStreams.delete(type);
    } else {
      // Clear all data
      events.clear();
      listeners.clear();
      pending.clear();
      resources.clear();
      recentlyUsedStreams.clear();
    }
  };

  return () => ({
    register,
    onReady,
    emit,
    update,
    on,
    clear,
  });
}
