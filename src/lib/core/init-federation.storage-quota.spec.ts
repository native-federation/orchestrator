import { initFederation } from './init-federation';
import { localStorageEntry, sessionStorageEntry } from './4.config/storage';
import type { StorageEntryCreator } from './2.app/config/storage.contract';
import type { ImportMap } from './1.domain/import-map/import-map.contract';
import type { Logger } from './2.app/config/log.contract';
import { mockManifest } from 'lib/testing/domain/manifest.mock';
import {
  mockRemoteEntry_MFE1,
  mockRemoteEntry_MFE2,
  mockRemoteEntry_MFE3,
} from 'lib/testing/domain/remote-entry/remote-entry.mock';
import { mockExposedModuleA } from 'lib/testing/domain/remote-entry/exposes-info.mock';

// Before the write guard, a write the storage rejected left `remotes` stored without the externals: initFederation
// rejected after installing its map, and every later warm page of the origin got `{"imports":{}}`.
describe.each([
  ['localStorage', localStorageEntry, () => localStorage],
  ['sessionStorage', sessionStorageEntry, () => sessionStorage],
] as [string, StorageEntryCreator, () => Storage][])(
  'initFederation (%s write failures)',
  (_, storage, webStorage) => {
    const NS = 'quota';
    // mfe3 shares nothing new, so its exposed module is what shows up in the runtime load's map.
    const mfe3 = mockRemoteEntry_MFE3({ exposes: [mockExposedModuleA()] });
    const remoteEntries = [mockRemoteEntry_MFE1(), mockRemoteEntry_MFE2(), mfe3];
    const full = new Set<string>();
    let fetches: number;
    let maps: ImportMap[];
    let logger: { [K in keyof Logger]: ReturnType<typeof vi.fn> };

    const init = (namespace = NS, opts: { strict?: boolean } = {}) =>
      initFederation(mockManifest(), {
        storage,
        storageNamespace: namespace,
        logger: logger as unknown as Logger,
        logLevel: 'warn',
        strict: { strictRemoteEntry: !!opts.strict },
        setImportMapFn: async map => {
          maps.push(map);
          return map;
        },
        loadModuleFn: async () => ({}),
      });

    const raw = (key: string) => JSON.parse(webStorage().getItem(`${NS}.${key}`) ?? 'null');

    const coldMap = async () => {
      await init('reference');
      return maps.pop();
    };

    const storageWarnings = () =>
      logger.warn.mock.calls.filter(([, msg]) => String(msg).includes('Could not save'));

    beforeEach(() => {
      localStorage.clear();
      sessionStorage.clear();
      full.clear();
      fetches = 0;
      maps = [];
      logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      globalThis.fetch = vi.fn(async (url: unknown) => {
        fetches++;
        const entry = remoteEntries.find(e => e.url === String(url));
        if (!entry) throw new Error(`No remoteEntry fixture for ${url}`);
        return { ok: true, json: async () => entry } as Response;
      });
      const setItem = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key: string,
        value: string
      ) {
        if (full.has(key))
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return setItem.call(this, key, value);
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('resolves with the full map when the externals write fails, and the next page starts cold', async () => {
      const expected = await coldMap();
      full.add(`${NS}.shared-externals`);

      await expect(init()).resolves.toBeDefined();

      expect(maps.pop()).toEqual(expected);
      expect(storageWarnings()).toEqual([
        [5, expect.stringContaining("'shared-externals'"), expect.any(DOMException)],
      ]);
      // The half-written state: the remotes went in before the throw, and the stamp is gone.
      expect(Object.keys(raw('remotes'))).toEqual(['team/mfe1', 'team/mfe2']);
      expect(raw('cache-state')?.version).toBeUndefined();

      full.clear();
      fetches = 0;
      await init();

      expect(fetches).toBe(2);
      expect(maps.pop()).toEqual(expected);
    });

    it('starts the next page cold when the first write of the commit fails', async () => {
      const expected = await coldMap();
      full.add(`${NS}.remotes`);

      await init();
      expect(maps.pop()).toEqual(expected);
      expect(raw('remotes')).toBeNull();

      full.clear();
      fetches = 0;
      await init();

      expect(fetches).toBe(2);
      expect(maps.pop()).toEqual(expected);
    });

    it('keeps every page cold and correct while the storage stays full', async () => {
      const expected = await coldMap();
      full.add(`${NS}.shared-externals`);
      await init();

      logger.warn.mockClear();
      fetches = 0;
      await init();

      expect(fetches).toBe(2);
      expect(maps.pop()).toEqual(expected);
      expect(storageWarnings()).toHaveLength(1);
    });

    it('resolves a runtime load whose commit fails, and the next page starts cold', async () => {
      const expected = await coldMap();
      const page = await init(NS, { strict: true });
      full.add(`${NS}.remotes`);

      await expect(page.initRemoteEntry(mfe3.url, 'team/mfe3')).resolves.toBeDefined();

      expect(page.adapters.remoteInfoRepo.contains('team/mfe3')).toBe(true);
      expect(Object.keys(maps.pop()!.imports)).toContain('team/mfe3/./wc-comp-a');
      expect(storageWarnings()).toHaveLength(1);

      full.clear();
      fetches = 0;
      await init();

      expect(fetches).toBe(2);
      expect(maps.pop()).toEqual(expected);
    });

    it("keeps this page's commit when a later runtime load rolls back", async () => {
      const page = await init();
      full.add(`${NS}.shared-externals`);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await page.initRemoteEntry(mfe3.url, 'team/mfe3');
      const externals = page.adapters.sharedExternalsRepo.getFromScope();
      expect(JSON.stringify(externals)).toContain('team/mfe3');

      // No fixture for this URL: the load fails and rolls the repositories back, which re-reads the storage
      // that never received mfe3's externals.
      await page.initRemoteEntry('http://missing/remoteEntry.json', 'team/missing');

      expect(page.adapters.remoteInfoRepo.contains('team/mfe3')).toBe(true);
      expect(page.adapters.sharedExternalsRepo.getFromScope()).toEqual(externals);
    });
  }
);
