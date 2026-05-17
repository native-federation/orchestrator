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

import { getLoaderBridge, __resetLoaderBridgeForTests } from './loader-bridge';

describe('loader-bridge', () => {
  beforeEach(() => {
    __resetLoaderBridgeForTests();
    mockRegister.mockReset();
    mockPorts.length = 0;
  });

  it('registers the bundled loader once on first construction', () => {
    getLoaderBridge();
    getLoaderBridge();
    getLoaderBridge();

    expect(mockRegister).toHaveBeenCalledTimes(1);
    const [url, opts] = mockRegister.mock.calls[0]!;
    expect(String(url)).toContain('node-loader/loader.mjs');
    expect(opts).toMatchObject({
      data: { port: mockPorts[0]!.port2 },
      transferList: [mockPorts[0]!.port2],
    });
  });

  it('unrefs port1 so the bridge does not keep the process alive', () => {
    getLoaderBridge();
    expect(mockPorts[0]!.port1.unref).toHaveBeenCalledTimes(1);
  });

  it('posts the import map on setMap and resolves when the loader acks', async () => {
    const bridge = getLoaderBridge();
    const map: ImportMap = { imports: { foo: '/foo.mjs' } };

    const pending = bridge.setMap(map);

    expect(mockPorts[0]!.port1.postMessage).toHaveBeenCalledWith({
      type: 'set-import-map',
      map,
    });

    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    mockPorts[0]!.port1.mockEmit({ type: 'import-map-applied' });
    await expect(pending).resolves.toBeUndefined();
  });

  it('ignores messages of other types until the right ack arrives', async () => {
    const bridge = getLoaderBridge();
    const pending = bridge.setMap({ imports: {} });

    mockPorts[0]!.port1.mockEmit({ type: 'unrelated' });
    mockPorts[0]!.port1.mockEmit(null);
    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    mockPorts[0]!.port1.mockEmit({ type: 'import-map-applied' });
    await expect(pending).resolves.toBeUndefined();
  });

  it('ready() reflects the latest setMap pending promise', async () => {
    const bridge = getLoaderBridge();
    await expect(bridge.ready()).resolves.toBeUndefined();

    const p1 = bridge.setMap({ imports: { a: '/a.mjs' } });
    expect(bridge.ready()).toBe(p1);
    mockPorts[0]!.port1.mockEmit({ type: 'import-map-applied' });
    await p1;

    const p2 = bridge.setMap({ imports: { b: '/b.mjs' } });
    expect(bridge.ready()).toBe(p2);
  });

  it('rejects setMap when postMessage throws and removes its listener', async () => {
    const bridge = getLoaderBridge();
    const boom = new Error('clone failed');
    mockPorts[0]!.port1.postMessage.mockImplementationOnce(() => {
      throw boom;
    });

    await expect(bridge.setMap({ imports: {} })).rejects.toBe(boom);

    expect(() => mockPorts[0]!.port1.mockEmit({ type: 'import-map-applied' })).not.toThrow();
  });
});
