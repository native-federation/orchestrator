import type { NativeFederationResult } from 'lib/core/init-federation.contract';
import { announceInitReady } from './announce-init-ready';

// Only the loader functions matter to the announcement; the rest of the result is irrelevant here.
const loaders = {
  loadRemoteModule: vi.fn(),
  load: vi.fn(),
  preloadRemoteModule: vi.fn(),
} as unknown as NativeFederationResult;

describe('announceInitReady', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing when neither the registry nor the bus is on the page', () => {
    expect(() => announceInitReady(loaders)).not.toThrow();
  });

  it('registers orch.init-ready on the registry', () => {
    const register = vi.fn();
    vi.stubGlobal('__NF_REGISTRY__', { register });

    announceInitReady(loaders);

    expect(register).toHaveBeenCalledWith(
      'orch.init-ready',
      expect.objectContaining({ loadRemoteModule: loaders.loadRemoteModule })
    );
  });

  // A hand-made stub of the communication package's protocol-1 bus: only emit is used.
  it('emits orch.init-ready on the bus with the same loader functions', () => {
    const emit = vi.fn();
    vi.stubGlobal('__NF_BUS__', { protocol: 1, emit });

    announceInitReady(loaders);

    expect(emit).toHaveBeenCalledTimes(1);
    const [channel, value] = emit.mock.calls[0]!;
    expect(channel).toBe('orch.init-ready');
    expect(value.loadRemoteModule).toBe(loaders.loadRemoteModule);
  });

  it('announces on both when both are on the page', () => {
    const register = vi.fn();
    const emit = vi.fn();
    vi.stubGlobal('__NF_REGISTRY__', { register });
    vi.stubGlobal('__NF_BUS__', { protocol: 1, emit });

    announceInitReady(loaders);

    expect(register).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
  });

  it('ignores a foreign object on __NF_BUS__ and still registers on the registry', () => {
    const register = vi.fn();
    vi.stubGlobal('__NF_REGISTRY__', { register });
    vi.stubGlobal('__NF_BUS__', {});

    expect(() => announceInitReady(loaders)).not.toThrow();
    expect(register).toHaveBeenCalledOnce();
  });
});
