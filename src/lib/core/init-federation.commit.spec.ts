import { initFederation } from './init-federation';
import { sessionStorageEntry } from './4.config/storage';
import { mockManifest } from 'lib/testing/domain/manifest.mock';
import {
  mockRemoteEntry_HOST,
  mockRemoteEntry_MFE1,
  mockRemoteEntry_MFE2,
} from 'lib/testing/domain/remote-entry/remote-entry.mock';

describe('initFederation (storage commits)', () => {
  let setItem: ReturnType<typeof vi.spyOn>;
  let fetches: number;

  const remoteEntries = [mockRemoteEntry_MFE1(), mockRemoteEntry_MFE2(), mockRemoteEntry_HOST()];

  const init = (namespace: string) =>
    initFederation(mockManifest(), {
      storage: sessionStorageEntry,
      storageNamespace: namespace,
      setImportMapFn: async importMap => importMap,
      loadModuleFn: async () => ({}),
    });

  const storageSnapshot = () =>
    Object.fromEntries(
      Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)!).map(key => [
        key,
        sessionStorage.getItem(key),
      ])
    );

  beforeEach(() => {
    sessionStorage.clear();
    fetches = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      fetches++;
      const entry = remoteEntries.find(e => e.url === String(url));
      if (!entry) throw new Error(`No remoteEntry fixture for ${url}`);
      return { ok: true, json: async () => entry } as Response;
    });
    setItem = vi.spyOn(Storage.prototype, 'setItem');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should write every storage key exactly once on a cold init', async () => {
    await init('cold');

    const keys = setItem.mock.calls.map(([key]) => key);

    expect(keys).toEqual([...new Set(keys)]);
    expect([...keys].sort()).toEqual([
      'cold.remotes',
      'cold.scoped-externals',
      'cold.shared-externals',
    ]);
  });

  it('should not write a storage key for a repository that stayed empty', async () => {
    await init('empty');

    expect(setItem).not.toHaveBeenCalledWith('empty.shared-chunks', expect.anything());
    expect(sessionStorage.getItem('empty.shared-chunks')).toBeNull();
  });

  it('should not write to storage on a warm init', async () => {
    await init('warm');

    expect(setItem).toHaveBeenCalled();
    const afterCold = storageSnapshot();

    setItem.mockClear();
    fetches = 0;

    await init('warm');

    expect(fetches).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(storageSnapshot()).toEqual(afterCold);
  });

  it('should write to storage again once a new remote is added', async () => {
    await init('added');
    setItem.mockClear();
    fetches = 0;

    await initFederation(
      { ...mockManifest(), 'team/host': mockRemoteEntry_HOST().url },
      {
        storage: sessionStorageEntry,
        storageNamespace: 'added',
        setImportMapFn: async importMap => importMap,
        loadModuleFn: async () => ({}),
      }
    );

    expect(fetches).toBe(1);
    expect(setItem.mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining(['added.remotes', 'added.shared-externals'])
    );
  });
});
