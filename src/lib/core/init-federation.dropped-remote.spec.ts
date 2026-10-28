import { initFederation } from './init-federation';
import { sessionStorageEntry } from './4.config/storage';
import type { ImportMap } from './1.domain';
import type { ModeProfileConfig } from './2.app/config/mode.contract';
import { cachingProfile, defaultProfile } from './4.config/mode';

/**
 * With `profile.mergeManifests: false`, a warm init after the manifest dropped a remote must build what a cold init
 * of the remaining manifest builds: the dropped remote's files leave the map, its copies leave the record, and the
 * externals it shipped are elected again. With the default `true`, the warm init keeps serving the dropped remote's
 * files, a 404 once its server is gone; pages may pass their own manifests, and storage merges them on purpose.
 *
 * The shapes avoid a cold downloads/tears tie on purpose: on an exact tie a warm init keeps the version it already
 * shares (docs/version-resolver.md), so it may differ from cold there by design.
 */
describe('initFederation (a remote the manifest does not list)', () => {
  type Shared = {
    version: string;
    requiredVersion?: string;
    strictVersion?: boolean;
    pool?: string;
  };

  const entry = (name: string, shared: Record<string, Shared>) => ({
    name,
    url: `http://${name}/remoteEntry.json`,
    exposes: [{ key: './x', outFileName: 'x.js' }],
    shared: Object.entries(shared).map(([packageName, s]) => ({
      packageName,
      singleton: true,
      strictVersion: s.strictVersion ?? false,
      requiredVersion: s.requiredVersion ?? `^${s.version}`,
      version: s.version,
      ...(s.pool ? { pool: s.pool } : {}),
      entries: { [packageName]: `${packageName}.js` },
    })),
  });

  let entries: ReturnType<typeof entry>[];
  let namespaces = 0;

  beforeEach(() => {
    sessionStorage.clear();
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const found = entries.find(e => e.url === String(url));
      if (!found) throw new Error(`No remoteEntry fixture for ${url}`);
      return { ok: true, json: async () => structuredClone(found) } as Response;
    });
  });

  const manifestOf = (remotes: ReturnType<typeof entry>[]) =>
    Object.fromEntries(remotes.map(e => [e.name, e.url]));

  const init = async (
    namespace: string,
    remotes: ReturnType<typeof entry>[],
    {
      strictExternalCompatibility = false,
      profile = { mergeManifests: false },
    }: { strictExternalCompatibility?: boolean; profile?: Partial<ModeProfileConfig> } = {}
  ) => {
    let importMap: ImportMap | undefined;
    const result = await initFederation(manifestOf(remotes), {
      storage: sessionStorageEntry,
      storageNamespace: namespace,
      strict: { strictExternalCompatibility },
      profile,
      setImportMapFn: async map => (importMap = map),
      loadModuleFn: async () => ({}),
    });
    return { result, importMap: importMap! };
  };

  // Every storage key but `cache-state`, whose marks record what this page decided, not what it holds.
  const records = (namespace: string) =>
    Object.fromEntries(
      ['remotes', 'shared-externals', 'scoped-externals', 'shared-chunks'].map(key => [
        key,
        JSON.parse(sessionStorage.getItem(`${namespace}.${key}`) ?? 'null'),
      ])
    );

  const expectWarmAsCold = async (
    all: ReturnType<typeof entry>[],
    dropped: string,
    strict = false
  ) => {
    entries = all;
    const kept = all.filter(e => e.name !== dropped);
    const coldNs = `cold-${namespaces}`;
    const warmNs = `warm-${namespaces++}`;

    const cold = await init(coldNs, kept, { strictExternalCompatibility: strict });
    await init(warmNs, all, { strictExternalCompatibility: strict });
    const warm = await init(warmNs, kept, { strictExternalCompatibility: strict });

    expect(warm.importMap).toEqual(cold.importMap);
    expect(records(warmNs)).toEqual(records(coldNs));
    expect(JSON.stringify(warm.importMap)).not.toContain(`http://${dropped}/`);
    await expect(warm.result.loadRemoteModule(dropped, './x')).rejects.toThrow(
      `Failed to load module ${dropped}/./x`
    );
  };

  it("drops the serving build's files", () =>
    expectWarmAsCold(
      [entry('r0', { rx: { version: '7.0.0' } }), entry('r1', { rx: { version: '7.1.0' } })],
      'r1'
    ));

  // r2 ships the newest `extra`; dropping it re-elects the external from cached copies only, where the strict
  // r0 decides the price.
  describe.each([false, true])(
    'a contested external re-elected (strictExternalCompatibility: %s)',
    strict => {
      it('elects what a cold init does', () =>
        expectWarmAsCold(
          [
            entry('r0', {
              extra: { version: '1.0.0', requiredVersion: '~1.0.0', strictVersion: true },
            }),
            entry('r1', { extra: { version: '1.1.0', requiredVersion: '^1.0.0' } }),
            entry('r2', { extra: { version: '1.2.0', requiredVersion: '^1.0.0' } }),
          ],
          'r2',
          strict
        ));
    }
  );

  it('re-elects a pool whose only labelled remote was dropped', () =>
    expectWarmAsCold(
      [
        entry('r0', { a: { version: '1.0.0' }, b: { version: '1.0.0' } }),
        entry('r1', {
          a: { version: '1.1.0', pool: 'p' },
          b: { version: '1.1.0', pool: 'p' },
        }),
        entry('r2', { a: { version: '1.0.0' }, b: { version: '1.1.0' } }),
      ],
      'r1'
    ));

  it('keeps every remote the manifest still lists', async () => {
    entries = [
      entry('r0', { rx: { version: '7.0.0' } }),
      entry('r1', { rx: { version: '7.1.0' } }),
    ];

    await init('same', entries);
    const before = records('same');
    await init('same', entries);

    expect(records('same')).toEqual(before);
  });

  // The app loads such a remote again with initRemoteEntry, which then fetches it.
  it('drops a remote loaded through initRemoteEntry, which a later initRemoteEntry fetches again', async () => {
    entries = [
      entry('r0', { rx: { version: '7.0.0' } }),
      entry('r1', { rx: { version: '7.0.0' } }),
    ];
    const page1 = await init('dynamic', [entries[0]!]);
    await page1.result.initRemoteEntry('http://r1/remoteEntry.json', 'r1');

    const page2 = await init('dynamic', [entries[0]!]);

    expect(Object.keys(records('dynamic')['remotes'])).toEqual(['r0']);
    expect(JSON.stringify(page2.importMap)).not.toContain('http://r1/');
    vi.mocked(globalThis.fetch).mockClear();
    await page2.result.initRemoteEntry('http://r1/remoteEntry.json', 'r1');
    expect(globalThis.fetch).toHaveBeenCalledWith('http://r1/remoteEntry.json');
  });

  // Green before the option existed, by design: it pins that the shipped profiles merge manifests, so a page with
  // its own manifest keeps the remotes other pages stored.
  it.each([
    ['defaultProfile', defaultProfile],
    ['cachingProfile', cachingProfile],
  ])('keeps a remote another page stored under %s', async (_, profile) => {
    entries = [
      entry('r0', { rx: { version: '7.0.0' } }),
      entry('r1', { rx: { version: '7.1.0' } }),
    ];
    await init('merged', entries, { profile });

    const page2 = await init('merged', [entries[0]!], { profile });

    expect(Object.keys(records('merged')['remotes']).sort()).toEqual(['r0', 'r1']);
    expect(page2.importMap.imports).toMatchObject({
      rx: 'http://r1/rx.js',
      'r1/./x': 'http://r1/x.js',
    });
  });
});
