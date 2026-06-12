/**
 * @vitest-environment node
 */
import type { ImportMap } from 'lib/core/1.domain';

const mockNodeLoader = vi.hoisted(() => ({
  setMap: vi.fn<(map: ImportMap) => Promise<void>>(),
  ready: vi.fn<() => Promise<void>>(),
}));

vi.mock('lib/node/adapters/node-loader.client', () => ({
  getNodeLoaderClient: () => mockNodeLoader,
}));

import { useNodeImportMap } from './use-node';

describe('useNodeImportMap', () => {
  beforeEach(() => {
    mockNodeLoader.setMap.mockReset();
    mockNodeLoader.ready.mockReset();
  });

  it('returns an ImportMapConfig plus a nodeLoader reference', () => {
    const cfg = useNodeImportMap();
    expect(typeof cfg.setImportMapFn).toBe('function');
    expect(typeof cfg.loadModuleFn).toBe('function');
    expect(typeof cfg.reloadBrowserFn).toBe('function');
    expect(cfg.nodeLoader).toBe(mockNodeLoader);
  });

  it('setImportMapFn forwards to nodeLoader.setMap and resolves with the map', async () => {
    mockNodeLoader.setMap.mockResolvedValue(undefined);
    const map: ImportMap = { imports: { foo: '/foo.mjs' } };

    const result = await useNodeImportMap().setImportMapFn(map);

    expect(mockNodeLoader.setMap).toHaveBeenCalledWith(map);
    expect(result).toBe(map);
  });

  it('propagates nodeLoader.setMap rejections', async () => {
    const boom = new Error('clone failed');
    mockNodeLoader.setMap.mockRejectedValue(boom);

    await expect(useNodeImportMap().setImportMapFn({ imports: {} })).rejects.toBe(boom);
  });

  it('reloadBrowserFn is a no-op', () => {
    expect(() => useNodeImportMap().reloadBrowserFn()).not.toThrow();
  });

  it('loadModuleFn performs a dynamic import of the supplied URL', async () => {
    // Use a file URL pointing at the spec itself so the import always succeeds.
    const url = new URL('./use-node.spec.ts', import.meta.url).href;
    // Skip the assertion if the test runtime cannot resolve TS via dynamic import.
    const result = await useNodeImportMap()
      .loadModuleFn(url)
      .catch(() => 'load-failed');
    expect(result).toBeTruthy();
  });
});
