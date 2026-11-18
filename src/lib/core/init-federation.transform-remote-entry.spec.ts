import { initFederation } from './init-federation';
import { sessionStorageEntry } from './4.config/storage';
import type { ImportMap } from './1.domain';
import type { RemoteEntry, TransformRemoteEntry } from '../options.index';
import { mockManifest } from 'lib/testing/domain/manifest.mock';
import {
  mockRemoteEntry_MFE1,
  mockRemoteEntry_MFE2,
  mockRemoteEntry_MFE3,
} from 'lib/testing/domain/remote-entry/remote-entry.mock';
import { mockExposedModuleA } from 'lib/testing/domain/remote-entry/exposes-info.mock';
import {
  mockScopeUrl_MFE1,
  mockScopeUrl_MFE2,
  mockScopeUrl_MFE3,
} from 'lib/testing/domain/scope-url.mock';

/**
 * `devtools.transformRemoteEntryFn` runs around the remoteEntry provider, once per fetched remoteEntry, right after the
 * fetch and before the orchestrator's checks (name, cache/override marking), processing and pooling, in both
 * `initFederation` and `initRemoteEntry`. A remote served from storage is not fetched, so not transformed.
 * The functions below never mutate their argument, so an assertion on the result can only pass when the
 * returned entry is the one used.
 */
describe('initFederation (devtools.transformRemoteEntryFn)', () => {
  let maps: ImportMap[];

  const mfe3 = mockRemoteEntry_MFE3({ exposes: [mockExposedModuleA()] });
  const mfe2Moved = {
    ...mockRemoteEntry_MFE2(),
    url: mockScopeUrl_MFE2({ file: 'v2/remoteEntry.json' }),
  };
  const remoteEntries = [mockRemoteEntry_MFE1(), mockRemoteEntry_MFE2(), mfe3, mfe2Moved];

  const unshare = (entry: RemoteEntry): RemoteEntry => ({
    ...entry,
    shared: entry.shared.map(shared => ({ ...shared, singleton: false })),
  });

  const init = (
    namespace: string,
    transformRemoteEntryFn?: TransformRemoteEntry,
    manifest = mockManifest()
  ) =>
    initFederation(manifest, {
      storage: sessionStorageEntry,
      storageNamespace: namespace,
      setImportMapFn: async importMap => {
        maps.push(importMap);
        return importMap;
      },
      loadModuleFn: async () => ({}),
      ...(transformRemoteEntryFn ? { devtools: { transformRemoteEntryFn } } : {}),
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
    maps = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const entry = remoteEntries.find(e => e.url === String(url));
      if (!entry) throw new Error(`No remoteEntry fixture for ${url}`);
      return { ok: true, json: async () => entry } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the function once per fetched remoteEntry, with only that entry', async () => {
    const transform = vi.fn((entry: RemoteEntry) => entry);

    await init('calls', transform);

    expect(transform).toHaveBeenCalledTimes(2);
    // Exact argument lists: the provider passes the entry only.
    expect(transform).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'team/mfe1', url: mockRemoteEntry_MFE1().url })
    );
    expect(transform).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'team/mfe2', url: mockRemoteEntry_MFE2().url })
    );
    transform.mock.calls.forEach(args => expect(args).toHaveLength(1));
  });

  it('resolves the entry an async function returns', async () => {
    const mfe1Scope = mockScopeUrl_MFE1();
    const mfe1Dep = (name: string) => mockScopeUrl_MFE1({ file: `${name}.js` });

    await init('baseline');
    // Without the transform mfe1 serves the shared dep-a and dep-b, so the assertions below can only pass
    // because of the transform.
    expect(maps.pop()!.imports).toMatchObject({
      'dep-a': mfe1Dep('dep-a'),
      'dep-b': mfe1Dep('dep-b'),
    });

    await init('async', async entry => (entry.name === 'team/mfe1' ? unshare(entry) : entry));
    const map = maps.pop()!;

    expect(Object.values(map.imports)).not.toContain(mfe1Dep('dep-a'));
    expect(Object.values(map.imports)).not.toContain(mfe1Dep('dep-b'));
    expect(map.scopes?.[mfe1Scope]).toEqual({
      'dep-a': mfe1Dep('dep-a'),
      'dep-b': mfe1Dep('dep-b'),
      'dep-c': mfe1Dep('dep-c'),
      'dep-d': mfe1Dep('dep-d'),
    });
  });

  describe('when the function throws', () => {
    const throwOnMfe2: TransformRemoteEntry = entry => {
      if (entry.name === 'team/mfe2') throw new Error('transform failed');
      return entry;
    };

    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    it('skips that remote like a failed fetch', async () => {
      const page = await init('throws', throwOnMfe2);
      const map = maps.pop()!;

      expect(page.adapters.remoteInfoRepo.contains('team/mfe2')).toBe(false);
      expect(page.adapters.remoteInfoRepo.contains('team/mfe1')).toBe(true);
      expect(JSON.stringify(map)).not.toContain(mockScopeUrl_MFE2());
    });

    it('rejects initFederation with strictRemoteEntry', async () => {
      await expect(
        initFederation(mockManifest(), {
          storage: sessionStorageEntry,
          storageNamespace: 'throws-strict',
          setImportMapFn: async importMap => importMap,
          loadModuleFn: async () => ({}),
          strict: { strictRemoteEntry: true },
          devtools: { transformRemoteEntryFn: throwOnMfe2 },
        })
      ).rejects.toThrow("Could not fetch remote 'team/mfe2'");
    });
  });

  describe('on a later page with the same storage', () => {
    it('does not transform a remote served from storage again', async () => {
      const page1 = vi.fn(unshare);
      await init('cached', page1);
      const page1Map = maps.pop()!;
      expect(page1Map.scopes?.[mockScopeUrl_MFE1()]).toHaveProperty('dep-a');

      const page2 = vi.fn((entry: RemoteEntry) => entry);
      await init('cached', page2, { ...mockManifest(), 'team/mfe2': mfe2Moved.url });

      expect(page2).toHaveBeenCalledTimes(1);
      expect(page2).toHaveBeenCalledWith(expect.objectContaining({ name: 'team/mfe2' }));
      // mfe1 was not fetched again, so it keeps page 1's transform.
      expect(maps.pop()!.scopes?.[mockScopeUrl_MFE1()]).toEqual(
        page1Map.scopes?.[mockScopeUrl_MFE1()]
      );
    });
  });

  describe('initRemoteEntry', () => {
    it('transforms the entry a dynamic init fetches, once', async () => {
      const transform = vi.fn(unshare);
      const page = await init('dynamic', entry =>
        entry.name === 'team/mfe3' ? transform(entry) : entry
      );

      await page.initRemoteEntry(mfe3.url, 'team/mfe3');

      expect(transform).toHaveBeenCalledTimes(1);
      expect(transform).toHaveBeenCalledWith(expect.objectContaining({ name: 'team/mfe3' }));
      // Shared, mfe3's dep-a 2.1.1 would reuse the page's dep-a and add no scope.
      expect(maps.pop()!.scopes).toEqual({
        [mockScopeUrl_MFE3()]: { 'dep-a': mockScopeUrl_MFE3({ file: 'dep-a.js' }) },
      });

      await page.initRemoteEntry(mfe3.url, 'team/mfe3');

      expect(transform).toHaveBeenCalledTimes(1);
    });

    it('rolls a throwing function back like a failed fetch', async () => {
      const page = await init('dynamic-throws', entry => {
        if (entry.name === 'team/mfe3') throw new Error('transform failed');
        return entry;
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const before = storageSnapshot();

      await expect(page.initRemoteEntry(mfe3.url, 'team/mfe3')).resolves.toBeDefined();

      expect(storageSnapshot()).toEqual(before);
      expect(page.adapters.remoteInfoRepo.contains('team/mfe3')).toBe(false);
    });
  });
});
