/**
 * @jest-environment node
 */
import type { ImportMap } from 'lib/1.domain';

// jest.mock() factories may only reference variables prefixed `mock*`.

type Handler = (msg: unknown) => void;

class MockFakePort {
  postMessage = jest.fn<void, [unknown]>();
  unref = jest.fn<void, []>();
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
const mockRegister = jest.fn();

jest.mock('node:worker_threads', () => ({
  MessageChannel: jest.fn(() => {
    const pair = { port1: new MockFakePort(), port2: new MockFakePort() };
    mockPorts.push(pair);
    return pair;
  }),
}));

jest.mock('node:module', () => ({
  register: (...args: unknown[]) => mockRegister(...args),
}));

jest.mock('./loader-url', () => ({
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
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('rejects setMap when the loader does not acknowledge within the timeout', async () => {
      const client = getNodeLoaderClient();
      const pending = client.setMap({ imports: {} });
      const settled = pending.then(
        () => ({ ok: true as const }),
        err => ({ ok: false as const, err })
      );

      await flushMicrotasks();
      jest.advanceTimersByTime(NODE_LOADER_CLIENT_ACK_TIMEOUT_MS);
      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      expect((outcome as { err: Error }).err.message).toMatch(/did not acknowledge/);

      // A late ack must not throw or revive the rejected promise.
      expect(() => mockPorts[0]!.port1.mockEmit({ type: 'import-map-applied' })).not.toThrow();
    });
  });
});
