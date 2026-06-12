/**
 * @jest-environment node
 */
import { createNoopSSE } from './noop-sse';

describe('createNoopSSE', () => {
  it('exposes the ForSSE shape', () => {
    const sse = createNoopSSE();
    expect(typeof sse.watchRemoteBuilds).toBe('function');
    expect(typeof sse.closeAll).toBe('function');
  });

  it('does nothing when methods are invoked', () => {
    const sse = createNoopSSE();
    expect(() => sse.watchRemoteBuilds('http://anything/sse')).not.toThrow();
    expect(() => sse.closeAll()).not.toThrow();
  });
});
