import { initFederation } from './init-federation';
import { sessionStorageEntry } from './4.config/storage';
import type { ImportMap } from './1.domain';

/**
 * Preloading end to end, on real repositories and the real map generators: what reaches
 * `preloadModulesFn`, in which order relative to the import map, and that every URL is one the
 * committed map (or a module's own relative import) actually requests.
 */
describe('initFederation (preloading)', () => {
  type Shared = {
    version: string;
    singleton?: boolean;
    preload?: true;
    chunks?: string[];
  };

  const entry = (
    name: string,
    shared: Record<string, Shared>,
    exposes: { key: string; chunks?: string[] }[] = [{ key: './x' }]
  ) => ({
    name,
    url: `http://${name}/remoteEntry.json`,
    exposes: exposes.map(({ key, chunks }) => ({
      key,
      outFileName: `${key.slice(2)}.js`,
      ...(chunks ? { chunks } : {}),
    })),
    shared: Object.entries(shared).map(([packageName, s]) => ({
      packageName,
      singleton: s.singleton ?? true,
      strictVersion: false,
      requiredVersion: `^${s.version.split('.')[0]}.0.0`,
      version: s.version,
      ...(s.preload ? { preload: s.preload } : {}),
      ...(s.chunks ? { chunks: s.chunks } : {}),
      entries: { [packageName]: `${packageName}.js` },
    })),
  });

  let entries: ReturnType<typeof entry>[];
  let namespaces = 0;
  // One log in call order, so a test can tell whether a preload came before or after its map.
  let calls: ({ map: ImportMap } | { preload: string[] } | { import: string })[];

  beforeEach(() => {
    sessionStorage.clear();
    calls = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const found = entries.find(e => e.url === String(url));
      if (!found) throw new Error(`No remoteEntry fixture for ${url}`);
      return { ok: true, json: async () => structuredClone(found) } as Response;
    });
  });

  const init = (
    remotes: ReturnType<typeof entry>[],
    options: Parameters<typeof initFederation>[1] = {}
  ) =>
    initFederation(Object.fromEntries(remotes.map(e => [e.name, e.url])), {
      storage: sessionStorageEntry,
      storageNamespace: `preload-${namespaces++}`,
      setImportMapFn: async map => {
        calls.push({ map: structuredClone(map) });
        return map;
      },
      loadModuleFn: async url => {
        calls.push({ import: url });
        return {};
      },
      preloadModulesFn: urls => calls.push({ preload: [...urls] }),
      ...options,
    });

  const logger = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

  const preloads = () => calls.flatMap(c => ('preload' in c ? [c.preload] : []));
  const maps = () => calls.flatMap(c => ('map' in c ? [c.map] : []));
  const mappedUrls = (map: ImportMap) => [
    ...Object.values(map.imports),
    ...Object.values(map.scopes ?? {}).flatMap(scope => Object.values(scope)),
  ];

  describe('loadRemoteModule', () => {
    it("preloads the module's chunks, then imports it", async () => {
      entries = [entry('r0', {}, [{ key: './x', chunks: ['chunk-A.js', 'chunk-B.js'] }])];
      const fed = await init(entries);
      calls = [];

      await fed.loadRemoteModule('r0', './x');

      expect(calls).toEqual([
        { preload: ['http://r0/chunk-A.js', 'http://r0/chunk-B.js'] },
        { import: 'http://r0/x.js' },
      ]);
    });

    it('preloadRemoteModule on the init result hints the module and its chunks', async () => {
      entries = [entry('r0', {}, [{ key: './x', chunks: ['chunk-A.js'] }])];
      const fed = await init(entries);
      calls = [];

      fed.preloadRemoteModule('r0', './x');

      expect(calls).toEqual([{ preload: ['http://r0/x.js', 'http://r0/chunk-A.js'] }]);
    });

    // A remote built by a core without the field publishes no chunks; nothing is sent rather than [].
    it('sends nothing for a module without chunks', async () => {
      entries = [entry('r0', {})];
      const fed = await init(entries);
      calls = [];

      await fed.loadRemoteModule('r0', './x');

      expect(calls).toEqual([{ import: 'http://r0/x.js' }]);
    });

    // The hint is advice: a host's broken preload function must not turn into a failed load.
    it('loads the module when preloading throws', async () => {
      entries = [entry('r0', {}, [{ key: './x', chunks: ['chunk-A.js'] }])];
      const fed = await initFederation(
        { r0: entries[0]!.url },
        {
          storage: sessionStorageEntry,
          storageNamespace: `preload-${namespaces++}`,
          setImportMapFn: async map => map,
          loadModuleFn: async () => ({ loaded: true }),
          preloadModulesFn: () => {
            throw new Error('broken host preload');
          },
        }
      );

      await expect(fed.loadRemoteModule('r0', './x')).resolves.toEqual({ loaded: true });
    });
  });

  describe('eager externals at init', () => {
    it("preloads a marked external's served entry and chunks, after its map", async () => {
      entries = [entry('r0', { lib: { version: '1.0.0', preload: true, chunks: ['chunk-L.js'] } })];

      await init(entries);

      const [map] = maps();
      expect(calls.findIndex(c => 'preload' in c)).toBeGreaterThan(
        calls.findIndex(c => 'map' in c)
      );
      expect(preloads()).toEqual([['http://r0/lib.js', 'http://r0/chunk-L.js']]);
      expect(mappedUrls(map!)).toContain('http://r0/lib.js');
    });

    // A host may insert its map later than the call; a preload before it would break the resolution.
    it('waits for an async setImportMapFn to insert the map', async () => {
      entries = [entry('r0', { lib: { version: '1.0.0', preload: true } })];

      await init(entries, {
        setImportMapFn: async map => {
          await new Promise(r => setTimeout(r, 10));
          calls.push({ map: structuredClone(map) });
          return map;
        },
      });

      await vi.waitFor(() => expect(preloads()).toHaveLength(1));
      expect(calls).toEqual([{ map: expect.anything() }, { preload: ['http://r0/lib.js'] }]);
    });

    // The hint's guard keeps a host's broken preload function from failing an init it does not belong to.
    it('commits and resolves when preloading throws', async () => {
      entries = [entry('r0', { lib: { version: '1.0.0', preload: true } })];
      const log = logger();
      const preloadModulesFn = vi.fn(() => {
        throw new Error('broken host preload');
      });

      await expect(
        init(entries, { preloadModulesFn, logger: log, logLevel: 'debug' })
      ).resolves.toBeDefined();

      await vi.waitFor(() => expect(preloadModulesFn).toHaveBeenCalledOnce());
      expect(maps()).toHaveLength(1);
      expect(log.error).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        5,
        'Ignored a failing preload hint.',
        expect.anything()
      );
    });

    it('preloads nothing when no served copy is marked', async () => {
      entries = [entry('r0', { lib: { version: '1.0.0' } })];

      await init(entries);

      expect(preloads()).toEqual([]);
    });

    // r1 ships the newer copy, so its files serve every remote and r0's never reach the map.
    describe('two copies of one singleton', () => {
      const servedUrl = async () => {
        await init(entries);
        return maps()[0]!.imports['lib'];
      };

      it("follows the served copy's flag", async () => {
        entries = [
          entry('r0', { lib: { version: '1.0.0' } }),
          entry('r1', { lib: { version: '1.1.0', preload: true } }),
        ];

        expect(await servedUrl()).toBe('http://r1/lib.js');
        expect(preloads()).toEqual([['http://r1/lib.js']]);
      });

      it('ignores a flag on the copy that lost version resolution', async () => {
        entries = [
          entry('r0', { lib: { version: '1.0.0', preload: true, chunks: ['chunk-0.js'] } }),
          entry('r1', { lib: { version: '1.1.0' } }),
        ];

        expect(await servedUrl()).toBe('http://r1/lib.js');
        expect(preloads()).toEqual([]);
      });
    });

    it("follows a scoped copy's own flag", async () => {
      entries = [
        entry('r0', { lib: { version: '1.0.0', singleton: false, preload: true } }),
        entry('r1', { lib: { version: '2.0.0', singleton: false } }),
      ];

      await init(entries);

      expect(preloads()).toEqual([['http://r0/lib.js']]);
      expect(mappedUrls(maps()[0]!)).toContain('http://r0/lib.js');
    });
  });

  describe('eager externals at initRemoteEntry', () => {
    // A map the browser refused resolves nothing, so nothing it would have served may be fetched. The
    // rejection goes to the logger and stays unhandled, as it was before preloading, for trackers that
    // listen for unhandled rejections; with no logger, that is the only trace it leaves.
    it.each([
      ['with a logger', true],
      ['without one', false],
    ])(
      'preloads nothing when the map is rejected, and reports it %s',
      async (_name, withLogger) => {
        entries = [entry('r0', {}), entry('r1', { other: { version: '1.0.0', preload: true } })];
        const log = logger();
        const refused = new Error('Import maps are not allowed after a module load');
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        let maps = 0;
        const fed = await init([entries[0]!], {
          setImportMapFn: async map => {
            if (maps++ > 0) throw refused;
            return map;
          },
          ...(withLogger ? { logger: log, logLevel: 'debug' as const } : {}),
        });
        calls = [];

        process.on('unhandledRejection', onUnhandled);
        try {
          await fed.initRemoteEntry('http://r1/remoteEntry.json', 'r1');
          await vi.waitFor(() => expect(unhandled).toEqual([refused]));
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }

        expect(preloads()).toEqual([]);
        if (withLogger)
          expect(log.error).toHaveBeenCalledWith(5, 'Could not add the import map.', refused);
      }
    );

    it("preloads the new remote's marked copy after its map", async () => {
      entries = [
        entry('r0', {}),
        entry('r1', { other: { version: '1.0.0', preload: true, chunks: ['chunk-O.js'] } }),
      ];
      const fed = await init([entries[0]!]);
      calls = [];

      await fed.initRemoteEntry('http://r1/remoteEntry.json', 'r1');

      expect(calls).toEqual([
        { map: expect.anything() },
        { preload: ['http://r1/other.js', 'http://r1/chunk-O.js'] },
      ]);
      expect(mappedUrls(maps()[0]!)).toContain('http://r1/other.js');
    });

    // A failed dynamic load is rolled back; nothing it would have served may be fetched. r1 stores its
    // marked copy before the invalid version fails it.
    it('preloads nothing when the load fails', async () => {
      entries = [
        entry('r0', {}),
        entry('r1', {
          other: { version: '1.0.0', preload: true },
          broken: { version: 'not-a-version' },
        }),
      ];
      const fed = await init([entries[0]!], { strict: true });
      calls = [];

      await expect(fed.initRemoteEntry('http://r1/remoteEntry.json', 'r1')).rejects.toThrow();

      expect(calls).toEqual([]);
    });
  });
});
