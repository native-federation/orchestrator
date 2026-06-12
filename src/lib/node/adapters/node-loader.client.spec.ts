/**
 * @vitest-environment node
 */
import type { ImportMap } from 'lib/core/1.domain';

// vi.mock() factories run before module-level declarations, so everything
// they reference must be created inside vi.hoisted().

type Handler = (msg: unknown) => void;

const { MockFakePort, mockPorts, mockRegister } = vi.hoisted(() => {
  class MockFakePort {
    postMessage = vi.fn<(msg: unknown) => void>();
    unref = vi.fn<() => void>();
    private handlers: Handler[] = [];
    on(event: 'message', fn: Handler): this {
      if (event === 'message') this.handlers.push(fn);
      return this;
    }
    off(event: 'message', fn: Handler): this {
      if (event === 'message') this.handlers = this.handlers.filter(h => h !== fn);
      return this;
    }
    /** Test helper: deliver a message to all current 'message' listeners. */
    mockEmit(msg: unknown): void {
      [...this.handlers].forEach(h => h(msg));
    }
  }

  const mockPorts: { port1: MockFakePort; port2: MockFakePort }[] = [];
  const mockRegister = vi.fn();

  return { MockFakePort, mockPorts, mockRegister };
});

vi.mock('node:worker_threads', () => ({
  // vitest 4: a mock called with `new` needs a `function` (not arrow) implementation.
  MessageChannel: vi.fn(function () {
    const pair = { port1: new MockFakePort(), port2: new MockFakePort() };
    mockPorts.push(pair);
    return pair;
  }),
}));

vi.mock('node:module', () => ({
  register: (...args: unknown[]) => mockRegister(...args),
}));

vi.mock('./loader-url', () => ({
  getLoaderUrl: () => new URL('file:///fake/dist/node-loader/loader.mjs'),
}));

import {
  getNodeLoaderClient,
  _resetNodeLoaderClient,
  NODE_LOADER_CLIENT_ACK_TIMEOUT_MS,
} from './node-loader.client';

/** Yield long enough for the serialization chain (catch → then → postAndAwaitAck) to run. */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe('node-loader.client', () => {
  beforeEach(() => {
    _resetNodeLoaderClient();
    mockRegister.mockReset();
    mockPorts.length = 0;
  });

  it('registers the bundled loader once on first construction', () => {
    getNodeLoaderClient();
    getNodeLoaderClient();
    getNodeLoaderClient();

    expect(mockRegister).toHaveBeenCalledTimes(1);
    const [url, opts] = mockRegister.mock.calls[0]!;
    expect(String(url)).toContain('node-loader/loader.mjs');
    expect(opts).toMatchObject({
      data: { port: mockPorts[0]!.port2 },
      transferList: [mockPorts[0]!.port2],
    });
  });

  it('unrefs port1 so the client does not keep the process alive', () => {
    getNodeLoaderClient();
    expect(mockPorts[0]!.port1.unref).toHaveBeenCalledTimes(1);
  });

  it('posts the import map on setMap and resolves when the loader acks', async () => {
    const client = getNodeLoaderClient();
    const map: ImportMap = { imports: { foo: '/foo.mjs' } };

    const pending = client.setMap(map);
    await flushMicrotasks();

    expect(mockPorts[0]!.port1.postMessage).toHaveBeenCalledWith({
      type: 'set-import-map',
      map,
    });

    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    mockPorts[0]!.port1.mockEmit({ type: 'import-map-applied' });
    await expect(pending).resolves.toBeUndefined();
  });

  it('posts the host instances on setHostInstances and resolves when the loader acks', async () => {
    const client = getNodeLoaderClient();
    const keys = { '@angular/core': ['Component'] };

    const pending = client.setHostInstances(keys);
    await flushMicrotasks();

    expect(mockPorts[0]!.port1.postMessage).toHaveBeenCalledWith({
      type: 'set-host-instances',
      keys,
    });

    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    mockPorts[0]!.port1.mockEmit({ type: 'host-instances-applied' });
    await expect(pending).resolves.toBeUndefined();
  });

  it('serializes setHostInstances behind a pending setMap and matches acks by type', async () => {
    const client = getNodeLoaderClient();
    const port1 = mockPorts[0]!.port1;

    const pMap = client.setMap({ imports: { a: '/a.mjs' } });
    const pHost = client.setHostInstances({ pkg: ['x'] });
    await flushMicrotasks();

    // Only set-import-map posted so far; set-host-instances waits its turn.
    expect(port1.postMessage).toHaveBeenCalledTimes(1);
    expect(port1.postMessage).toHaveBeenNthCalledWith(1, {
      type: 'set-import-map',
      map: { imports: { a: '/a.mjs' } },
    });

    let hostResolved = false;
    pHost.then(() => {
      hostResolved = true;
    });

    // A host-instances ack must NOT resolve the still-pending setMap.
    port1.mockEmit({ type: 'host-instances-applied' });
    await flushMicrotasks();
    expect(hostResolved).toBe(false);

    // The correct ack releases setMap and lets set-host-instances post.
    port1.mockEmit({ type: 'import-map-applied' });
    await pMap;
    await flushMicrotasks();
    expect(hostResolved).toBe(false);
    expect(port1.postMessage).toHaveBeenNthCalledWith(2, {
      type: 'set-host-instances',
      keys: { pkg: ['x'] },
    });

    port1.mockEmit({ type: 'host-instances-applied' });
    await expect(pHost).resolves.toBeUndefined();
  });

  it('strips bridged specifiers from the import map it posts', async () => {
    const client = getNodeLoaderClient();
    const port1 = mockPorts[0]!.port1;

    client.setHostInstances({ '@angular/core': ['Component'] });
    await flushMicrotasks();
    port1.mockEmit({ type: 'host-instances-applied' });
    await flushMicrotasks();

    client.setMap({
      imports: { '@angular/core': '/ng.mjs', '@angular/core/': '/ng/', foo: '/foo.mjs' },
      scopes: { '/a/': { '@angular/core': '/scoped-ng.mjs', bar: '/bar.mjs' } },
    });
    await flushMicrotasks();

    expect(port1.postMessage).toHaveBeenNthCalledWith(2, {
      type: 'set-import-map',
      map: {
        // Exact bridged specifier dropped; trailing-slash + others kept.
        imports: { '@angular/core/': '/ng/', foo: '/foo.mjs' },
        scopes: { '/a/': { bar: '/bar.mjs' } },
      },
    });
  });

  it('ignores messages of other types until the right ack arrives', async () => {
    const client = getNodeLoaderClient();
    const pending = client.setMap({ imports: {} });
    await flushMicrotasks();

    mockPorts[0]!.port1.mockEmit({ type: 'unrelated' });
    mockPorts[0]!.port1.mockEmit(null);
    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    mockPorts[0]!.port1.mockEmit({ type: 'import-map-applied' });
    await expect(pending).resolves.toBeUndefined();
  });

  it('ready() reflects the latest setMap pending promise', async () => {
    const client = getNodeLoaderClient();
    await expect(client.ready()).resolves.toBeUndefined();

    const p1 = client.setMap({ imports: { a: '/a.mjs' } });
    expect(client.ready()).toBe(p1);
    await flushMicrotasks();
    mockPorts[0]!.port1.mockEmit({ type: 'import-map-applied' });
    await p1;

    const p2 = client.setMap({ imports: { b: '/b.mjs' } });
    expect(client.ready()).toBe(p2);
  });

  it('rejects setMap when postMessage throws and removes its listener', async () => {
    const client = getNodeLoaderClient();
    const boom = new Error('clone failed');
    mockPorts[0]!.port1.postMessage.mockImplementationOnce(() => {
      throw boom;
    });

    await expect(client.setMap({ imports: {} })).rejects.toBe(boom);

    expect(() => mockPorts[0]!.port1.mockEmit({ type: 'import-map-applied' })).not.toThrow();
  });

  it('serializes concurrent setMap calls so the ack of map A cannot resolve setMap(B)', async () => {
    const client = getNodeLoaderClient();
    const port1 = mockPorts[0]!.port1;

    const pA = client.setMap({ imports: { a: '/a.mjs' } });
    const pB = client.setMap({ imports: { b: '/b.mjs' } });
    await flushMicrotasks();

    // Only the first map should have been posted; B waits its turn.
    expect(port1.postMessage).toHaveBeenCalledTimes(1);
    expect(port1.postMessage).toHaveBeenNthCalledWith(1, {
      type: 'set-import-map',
      map: { imports: { a: '/a.mjs' } },
    });

    let bResolved = false;
    pB.then(() => {
      bResolved = true;
    });

    // Acknowledge A. B must NOT resolve yet — and B must now be posted.
    port1.mockEmit({ type: 'import-map-applied' });
    await pA;
    await flushMicrotasks();
    expect(bResolved).toBe(false);
    expect(port1.postMessage).toHaveBeenCalledTimes(2);
    expect(port1.postMessage).toHaveBeenNthCalledWith(2, {
      type: 'set-import-map',
      map: { imports: { b: '/b.mjs' } },
    });

    // Now ack B.
    port1.mockEmit({ type: 'import-map-applied' });
    await expect(pB).resolves.toBeUndefined();
  });

  it('still posts and resolves the next setMap after a postMessage rejection', async () => {
    const client = getNodeLoaderClient();
    const port1 = mockPorts[0]!.port1;
    const boom = new Error('clone failed');
    port1.postMessage.mockImplementationOnce(() => {
      throw boom;
    });

    await expect(client.setMap({ imports: {} })).rejects.toBe(boom);

    const next = client.setMap({ imports: { ok: '/ok.mjs' } });
    await flushMicrotasks();
    expect(port1.postMessage).toHaveBeenLastCalledWith({
      type: 'set-import-map',
      map: { imports: { ok: '/ok.mjs' } },
    });
    port1.mockEmit({ type: 'import-map-applied' });
    await expect(next).resolves.toBeUndefined();
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects setMap when the loader does not acknowledge within the timeout', async () => {
      const client = getNodeLoaderClient();
      const pending = client.setMap({ imports: {} });
      const settled = pending.then(
        () => ({ ok: true as const }),
        err => ({ ok: false as const, err })
      );

      await flushMicrotasks();
      vi.advanceTimersByTime(NODE_LOADER_CLIENT_ACK_TIMEOUT_MS);
      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      expect((outcome as { err: Error }).err.message).toMatch(/did not acknowledge/);

      // A late ack must not throw or revive the rejected promise.
      expect(() => mockPorts[0]!.port1.mockEmit({ type: 'import-map-applied' })).not.toThrow();
    });
  });
});
