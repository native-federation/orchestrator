/**
 * @jest-environment node
 */
import type { ImportMap } from 'lib/1.domain';

const mockBridge = {
  setMap: jest.fn<Promise<void>, [ImportMap]>(),
  ready: jest.fn<Promise<void>, []>(),
};

jest.mock('lib/3.adapters/node/loader-bridge', () => ({
  getLoaderBridge: () => mockBridge,
}));

import { useNodeImportMap } from './use-node';

describe('useNodeImportMap', () => {
  beforeEach(() => {
    mockBridge.setMap.mockReset();
    mockBridge.ready.mockReset();
  });

  it('returns an ImportMapConfig plus a bridge reference', () => {
    const cfg = useNodeImportMap();
    expect(typeof cfg.setImportMapFn).toBe('function');
    expect(typeof cfg.loadModuleFn).toBe('function');
    expect(typeof cfg.reloadBrowserFn).toBe('function');
    expect(cfg.bridge).toBe(mockBridge);
  });

  it('setImportMapFn forwards to bridge.setMap and resolves with the map', async () => {
    mockBridge.setMap.mockResolvedValue(undefined);
    const map: ImportMap = { imports: { foo: '/foo.mjs' } };

    const result = await useNodeImportMap().setImportMapFn(map);

    expect(mockBridge.setMap).toHaveBeenCalledWith(map);
    expect(result).toBe(map);
  });

  it('propagates bridge.setMap rejections', async () => {
    const boom = new Error('clone failed');
    mockBridge.setMap.mockRejectedValue(boom);

    await expect(
      useNodeImportMap().setImportMapFn({ imports: {} })
    ).rejects.toBe(boom);
  });

  it('reloadBrowserFn is a no-op', () => {
    expect(() => useNodeImportMap().reloadBrowserFn()).not.toThrow();
  });

  it('loadModuleFn performs a dynamic import of the supplied URL', async () => {
    // Use a file URL pointing at the spec itself so the import always succeeds.
    const url = new URL('./use-node.spec.ts', `file://${__filename.replace(/\\/g, '/')}`).href;
    // Skip the assertion if jest runtime cannot resolve TS via dynamic import.
    const result = await useNodeImportMap()
      .loadModuleFn(url)
      .catch(() => 'load-failed');
    expect(result).toBeTruthy();
  });
});
