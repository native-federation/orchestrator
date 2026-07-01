[< back](./../README.md)

# Event Registry

The orchestrator ships with a small in-page event bus, exposed as `window.__NF_REGISTRY__`. It is what `init-registry.mjs` boots up before the rest of the orchestrator runtime arrives, and is intended for two jobs:

1. **Resolving init promises retroactively.** A subscriber that arrives after the orchestrator has finished initializing still receives `orch.init-ready` — this avoids the race-condition class that plain `window.addEventListener` events suffer from.
2. **Robust cross-MFE communication.** Micro frontends can publish and subscribe to typed streams without holding direct references to each other.

The registry distinguishes two concepts:

- **Resources** — fire-and-latch values delivered through `register` / `onReady`. Once registered, every future `onReady` consumer fires immediately. Use these for one-shot readiness signals (the orchestrator itself uses this for `orch.init-ready`).
- **Event streams** — append-only buffers delivered through `emit` / `update` / `on`. Streams are bounded by `maxEvents` and (optionally) `maxStreams`, and subscribers get configurable history replay.

## Installation

Include `init-registry.mjs` **before** the rest of your scripts. Optionally tune the bus via `data-*` attributes on the script tag:

```html
<script
  src="https://unpkg.com/@softarc/native-federation-orchestrator@4.4.0/init-registry.mjs"
  data-max-streams="50"
  data-max-events="50"
  data-remove-percentage="50"
></script>
```

After this script runs, `window.__NF_REGISTRY__` is a frozen `NFEventRegistry` instance.

## Configuration

| Attribute             | Default | Effect                                                                                                                                           |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data-max-streams`    | `50`    | Maximum number of distinct stream types the registry will retain. When exceeded, the least-recently-emitted stream (and its history) is evicted. |
| `data-max-events`     | `50`    | Per-stream history depth. When exceeded, the oldest events are dropped — see [Trimming](#trimming) below.                                        |
| `data-remove-percent` | `50`    | When trimming kicks in, this percentage of the buffer is evicted in one batch (so subsequent emits don't slice on every call). Expressed in %.   |

If you instantiate the registry yourself via `createRegistry({ ... })` rather than the script, the equivalent options are `maxStreams`, `maxEvents`, and `removePercentage` (as a fraction, e.g. `0.5`).

### Trimming

The trim policy is "batch eviction." When a stream's history exceeds `maxEvents`, the registry drops `ceil(maxEvents * removePercentage)` of the oldest events at once, leaving the most recent `maxEvents - removed` events. This avoids slicing on every emit at the cost of a brief overshoot.

At least one event is always retained — even with `removePercentage: 1.0` or `maxEvents: 1`, the most recent event stays available for new subscribers.

## API

The full type is `NFEventRegistry`:

```ts
type NFEventRegistry = {
  // Resources (one-shot readiness)
  register<T>(type: string, resource: T | (() => Promise<T> | T)): Promise<void>;
  onReady<T>(type: string, callback: (value: T) => void): NFEventUnsubscribe;

  // Event streams
  emit<T>(type: string, data: T): void;
  update<T>(type: string, reducer: (current: T | undefined) => T): void;
  on<T>(
    type: string,
    callback: (event: { data: T; timestamp: number }) => void,
    opts?: { replay?: number }
  ): NFEventUnsubscribe;

  // Maintenance
  clear(type?: string): void;
};
```

### Resources

#### `register(type, resource)`

Stores `resource` under `type`. If `resource` is a function, it is invoked (and awaited) and the result is stored. Any consumers waiting via `onReady(type, …)` are notified.

```js
__NF_REGISTRY__.register('app-config', async () => fetch('/config.json').then(r => r.json()));
```

#### `onReady(type, callback)`

If `type` is already registered, `callback` fires synchronously with the value. Otherwise it is queued and fires the moment `register(type, …)` runs.

```js
__NF_REGISTRY__.onReady('orch.init-ready', ({ loadRemoteModule }) => {
  loadRemoteModule('team/mfe1', './Button');
});
```

Returns an unsubscribe function. When `type` was already registered, the returned function is a no-op (the callback has already fired).

### Event streams

#### `emit(type, data)`

Publishes an event on `type`. The event is wrapped with a `timestamp`, appended to the stream's history, and delivered synchronously to every current subscriber.

```js
__NF_REGISTRY__.emit('cart.changed', { itemCount: 3 });
```

#### `update(type, reducer)`

Publishes a new event whose value is derived from the previous one — useful when the next state depends on the last (counters, accumulating buffers, toggles).

The reducer receives a **structured clone** of the last value (or `undefined` if the stream is empty), so it cannot accidentally mutate stored history.

```js
__NF_REGISTRY__.update('cart.itemCount', current => (current ?? 0) + 1);
```

> Values passed through `update` must be structured-clone-able when the stream is non-empty (no functions, DOM nodes, or class instances).

#### `on(type, callback, opts?)`

Subscribes `callback` to `type` for every future event. On subscribe, the most recent `opts.replay` events from history are delivered via a microtask (so the unsubscribe handle is returned synchronously, and the replay fires after the current task completes).

| `opts.replay` | Behavior                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1` (default) | Deliver only the most recent event — matches the "BehaviorSubject" pattern, where a fresh subscriber always sees the current state. Right default for state-channels.                                                |
| `0`           | Suppress replay entirely. The subscriber only sees events emitted after it subscribes — right for one-shot signals where past history is irrelevant.                                                                 |
| `N`           | Deliver up to the last `N` events in chronological order. Capped implicitly by `maxEvents`. Right for late-joining consumers that need recent context (e.g. a debug panel that wants the last 10 navigation events). |

```js
// Default: get the latest cart state immediately, then every future change.
__NF_REGISTRY__.on('cart.changed', ({ data, timestamp }) => render(data));

// Subscribe without backfill.
__NF_REGISTRY__.on('user.clicked', ({ data }) => track(data), { replay: 0 });

// Backfill the last 10 navigation events.
__NF_REGISTRY__.on('nav.route', ({ data }) => log(data), { replay: 10 });
```

Returns an unsubscribe function that removes the listener.

### Maintenance

#### `clear(type?)`

With a `type`, drops the stream's history, listeners, registered resource, and pending `onReady` callbacks for that key. Without a `type`, wipes the entire registry. Useful in tests; rarely needed in production.

## Patterns

### State channel (BehaviorSubject-style)

```js
// Producer
__NF_REGISTRY__.update('cart.itemCount', n => (n ?? 0) + 1);

// Consumer — gets the current count on subscribe + every change after
__NF_REGISTRY__.on('cart.itemCount', ({ data }) => {
  document.querySelector('#cart-badge').textContent = data;
});
```

### Event log (multiple subscribers, no backfill)

```js
// Producer
__NF_REGISTRY__.emit('analytics.click', { id: 'cta-1' });

// Consumer — only sees events after subscribe
__NF_REGISTRY__.on('analytics.click', ({ data }) => track(data), { replay: 0 });
```

### Late-joining diagnostic (bounded backfill)

```js
__NF_REGISTRY__.on(
  'orch.module-loaded',
  ({ data, timestamp }) => debugPanel.append({ ...data, at: timestamp }),
  { replay: 50 }
);
```
