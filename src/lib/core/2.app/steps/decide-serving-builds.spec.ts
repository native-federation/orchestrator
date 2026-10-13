import type { ConfigContract } from 'lib/core/2.app/config';
import type {
  DenseSharedInfo,
  RemoteEntry,
  SharedExternal,
  SharedVersion,
  SharedVersionAction,
} from 'lib/core/1.domain';
import { GLOBAL_SCOPE } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { NFError } from 'lib/core/native-federation.error';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { pageFaults } from 'lib/testing/pooling/page-graph';
import { portfolio } from 'lib/testing/pooling/portfolio';
import type { DrivingContract } from '../driving-ports/driving.contract';
import { createDecideServingBuilds } from './decide-serving-builds';

describe('createDecideServingBuilds', () => {
  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-decide-serving-builds'),
      clearStorage: true,
    });
  });

  type Copy = { remote: string; req?: string; strict?: boolean; ships?: string[] };

  // Each copy ships the external it sits in, or what `ships` lists.
  const row = (
    external: string,
    tag: string,
    action: SharedVersionAction,
    copies: Copy[]
  ): SharedVersion => ({
    tag,
    host: false,
    action,
    remotes: copies.map(c =>
      mockVersionRemote(c.remote, external, {
        requiredVersion: c.req ?? `~${tag}`,
        strictVersion: c.strict ?? false,
        ...(c.ships ? { entries: Object.fromEntries(c.ships.map(e => [e, `${e}.js`])) } : {}),
      })
    ),
  });

  const seed = (
    externals: Record<string, SharedVersion[] | SharedExternal>,
    shareScope = GLOBAL_SCOPE
  ) => {
    for (const [name, value] of Object.entries(externals))
      adapters.sharedExternalsRepo.addOrUpdate(
        name,
        Array.isArray(value) ? { dirty: false, versions: value } : value,
        shareScope
      );
  };

  const stored = (shareScope = GLOBAL_SCOPE) =>
    adapters.sharedExternalsRepo.getFromScope(shareScope);

  const rowsOf = (name: string, shareScope = GLOBAL_SCOPE) =>
    stored(shareScope)[name]!.versions.map(
      v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name).join(',')}]`
    );

  const decide = () => createDecideServingBuilds(config, adapters)();

  it('stores the serving build on every external of the package, skip- and scope-only ones included', async () => {
    seed({
      fw: [row('fw', '2.0.0', 'share', [{ remote: 'a' }])],
      'fw/testing': [row('fw/testing', '2.0.0', 'skip', [{ remote: 'b' }])],
      'fw/extra': [row('fw/extra', '1.0.0', 'scope', [{ remote: 'c', strict: true }])],
      other: [row('other', '1.0.0', 'share', [{ remote: 'c' }])],
    });

    await decide();

    expect(stored().fw!.servingBuild).toBe('a');
    expect(stored()['fw/testing']!.servingBuild).toBe('a');
    expect(stored()['fw/extra']!.servingBuild).toBe('a');
    // Another package decides on its own.
    expect(stored().other!.servingBuild).toBe('c');
  });

  it('decides each named share scope on its own and writes into it', async () => {
    seed({ fw: [row('fw', '2.0.0', 'share', [{ remote: 'a' }])] });
    seed({ fw: [row('fw', '1.0.0', 'share', [{ remote: 'b' }])] }, 'team');

    await decide();

    expect(stored().fw!.servingBuild).toBe('a');
    expect(stored('team').fw!.servingBuild).toBe('b');
  });

  it('removes the field from a package that has no share row left', async () => {
    seed({
      fw: {
        dirty: false,
        servingBuild: 'a',
        versions: [row('fw', '1.0.0', 'scope', [{ remote: 'a', strict: true }])],
      },
    });

    await decide();

    // Removed, not stored as `undefined`.
    expect('servingBuild' in stored().fw!).toBe(false);
  });

  // The serving build ships every secondary below, so each still resolves once it follows.
  const shipsAll = { remote: 'a', ships: ['fw', 'fw/testing', 'fw/other'] };

  describe('a secondary shared at another tag than the serving build', () => {
    const splitPackage = () =>
      seed({
        fw: [row('fw', '2.0.0', 'share', [shipsAll])],
        'fw/testing': [row('fw/testing', '1.0.0', 'share', [{ remote: 'b', strict: true }])],
        'fw/other': [row('fw/other', '1.5.0', 'share', [{ remote: 'c' }])],
      });

    it('moves a strict copy whose range rejects the serving tag to scope and a non-strict one to skip', async () => {
      splitPackage();

      await decide();

      expect(rowsOf('fw')).toEqual(['2.0.0:share:[a]']);
      expect(rowsOf('fw/testing')).toEqual(['1.0.0:scope:[b]']);
      expect(rowsOf('fw/other')).toEqual(['1.5.0:skip:[c]']);
      expect(config.log.error).not.toHaveBeenCalled();
    });

    it('throws for the strict copy under strictExternalCompatibility', async () => {
      config.strict.strictExternalCompatibility = true;
      splitPackage();

      await expect(decide()).rejects.toEqual(
        new NFError('External fw/testing@1.0.0 could not be shared.')
      );
      expect(config.log.error).toHaveBeenCalledWith(
        3,
        "[b][fw/testing@1.0.0] Is not compatible with requiredRange '~1.0.0' of shared fw@2.0.0."
      );
    });
  });

  describe('a pooled package', () => {
    const versions = {
      fw: [row('fw', '2.0.0', 'share', [shipsAll])],
      'fw/testing': [row('fw/testing', '1.0.0', 'share', [{ remote: 'b', strict: true }])],
    };
    // As the election stores it: the same pool and winner on every member.
    const seedPool = (poolWinner?: string) =>
      seed(
        Object.fromEntries(
          Object.entries(versions).map(([name, rows]) => [
            name,
            {
              dirty: false,
              poolName: 'p',
              ...(poolWinner ? { poolWinner } : {}),
              versions: structuredClone(rows),
            },
          ])
        )
      );

    it('keeps the rows the election placed and stores its winner as the serving build', async () => {
      seedPool('a');

      await decide();

      expect(stored().fw!.versions).toEqual(versions.fw);
      expect(stored()['fw/testing']!.versions).toEqual(versions['fw/testing']);
      expect(stored()['fw/testing']!.servingBuild).toBe('a');
    });

    it('stores the widest copy of the root as the serving build without a winner, and keeps the rows', async () => {
      seedPool();

      await decide();

      expect(stored().fw!.versions).toEqual(versions.fw);
      expect(stored()['fw/testing']!.versions).toEqual(versions['fw/testing']);
      expect(stored().fw!.servingBuild).toBe('a');
      expect(stored()['fw/testing']!.servingBuild).toBe('a');
    });
  });

  it('redirects a secondary that has a share row of its own at the serving tag', async () => {
    seed({
      fw: [row('fw', '2.0.0', 'share', [{ remote: 'a', ships: ['fw', 'fw/testing'] }])],
      'fw/testing': [
        row('fw/testing', '2.0.0', 'share', [{ remote: 'e' }]),
        row('fw/testing', '1.0.0', 'share', [{ remote: 'b' }]),
      ],
    });

    await decide();

    expect(rowsOf('fw/testing')).toEqual(['2.0.0:share:[e]', '1.0.0:skip:[b]']);
  });

  describe('a remote shipping a specifier the serving build lacks', () => {
    // a and b each ship a specifier the other lacks and cost the same; a is the root's basis.
    const a = { remote: 'a', ships: ['fw', 'fw/other'] };

    it('runs the whole package from its own build, every copy on a scope row at its own tag', async () => {
      seed({
        fw: [row('fw', '2.0.0', 'share', [a, { remote: 'b' }])],
        'fw/testing': [row('fw/testing', '1.0.0', 'share', [{ remote: 'b' }])],
      });

      await decide();

      expect(rowsOf('fw')).toEqual(['2.0.0:share:[a]', '2.0.0:scope:[b]']);
      expect(rowsOf('fw/testing')).toEqual(['1.0.0:scope:[b]']);
      expect(stored()['fw/testing']!.servingBuild).toBe('a');
      expect(config.log.warn).not.toHaveBeenCalled();
      expect(config.log.debug).not.toHaveBeenCalled();
    });

    it('falls back before the package follows the serving build, so its strict range never fails init', async () => {
      config.strict.strictExternalCompatibility = true;
      seed({
        fw: [
          row('fw', '2.0.0', 'share', [a]),
          row('fw', '1.0.0', 'share', [{ remote: 'b', strict: true }]),
        ],
        'fw/testing': [row('fw/testing', '1.0.0', 'skip', [{ remote: 'b', strict: true }])],
      });

      await decide();

      expect(rowsOf('fw')).toEqual(['2.0.0:share:[a]', '1.0.0:scope:[b]']);
      expect(rowsOf('fw/testing')).toEqual(['1.0.0:scope:[b]']);
      expect(config.log.error).not.toHaveBeenCalled();
    });

    it("puts a newer copy's scope row above an older serving build", async () => {
      // The newer copy is not strict, so it skips to the older majority; its emptied row has to give its place
      // to the scope row, or the record would stop being newest-first.
      seed({
        'dep-a': [
          row('dep-a', '2.2.0', 'skip', [
            { remote: 'team/mfe-n', req: '^2.2.0', ships: ['dep-a', 'dep-a/extra'] },
          ]),
          row(
            'dep-a',
            '2.1.0',
            'share',
            Array.from({ length: 4 }, (_, i) => ({ remote: `team/maj${i + 1}` }))
          ),
        ],
      });

      await decide();

      expect(rowsOf('dep-a')).toEqual([
        '2.2.0:scope:[team/mfe-n]',
        '2.1.0:share:[team/maj1,team/maj2,team/maj3,team/maj4]',
      ]);
    });
  });

  // b serves fw at 2.0.0 and ships fw/x there too, but fw/x's own election took r's newer copy, so b's fw/x
  // sits on a skip row. r ships nothing but fw/x, which b's copy covers.
  describe("a secondary whose own election skipped the serving build's copy", () => {
    const shared = (name: string, version: string, strictVersion: boolean): DenseSharedInfo =>
      ({
        packageName: name,
        version,
        requiredVersion: `^${version}`,
        singleton: true,
        strictVersion,
        entries: { [name]: `${name.replace('/', '_')}.js` },
      }) as DenseSharedInfo;
    const entry = (name: string, ...sharedInfo: DenseSharedInfo[]): RemoteEntry =>
      ({
        name,
        url: `http://${name}/remoteEntry.json`,
        exposes: [],
        shared: sharedInfo,
      }) as unknown as RemoteEntry;
    const page = (strict: boolean) => [
      entry('b', shared('fw', '2.0.0', false), shared('fw/x', '2.0.0', false)),
      entry('r', shared('fw/x', '3.0.0', strict)),
    ];

    let storage = 0;
    const init = async (strict: boolean, order: (e: RemoteEntry[]) => RemoteEntry[]) => {
      const p = portfolio(
        {},
        { storage: `nf-dsb-serving-skip-${storage++}`, realRepositories: true }
      );
      p.config.strict.strictImportMap = true;
      const entries = order(page(strict));
      const map = await p.runInit(entries);
      const rows = () =>
        Object.fromEntries(
          Object.entries(p.stored()).map(([name, e]) => [
            name,
            e.versions.map(v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name)}]`),
          ])
        );
      return { p, map, rows, entries };
    };

    describe.each([
      ['b first', (e: RemoteEntry[]) => e],
      ['r first', (e: RemoteEntry[]) => [...e].reverse()],
    ])('%s', (_, order) => {
      it("publishes b's copy as the one share row, which r's covered copy follows", async () => {
        const { p, map, rows, entries } = await init(false, order);

        expect(rows()).toEqual({
          fw: ['2.0.0:share:[b]'],
          'fw/x': ['3.0.0:skip:[r]', '2.0.0:share:[b]'],
        });
        expect(map.imports).toEqual({ fw: 'http://b/fw.js', 'fw/x': 'http://b/fw_x.js' });
        expect(pageFaults({ importMap: map, entries })).toEqual({});
        // strictImportMap is on: two share rows of one external would have warned and thrown.
        expect(p.config.log.warn).not.toHaveBeenCalled();
      });

      it('keeps a strict copy that rejects the serving tag on its own build', async () => {
        const { map, rows } = await init(true, order);

        expect(rows()['fw/x']).toEqual(['3.0.0:scope:[r]', '2.0.0:share:[b]']);
        expect(map.imports['fw/x']).toBe('http://b/fw_x.js');
      });

      it('stores and maps the same on a warm init', async () => {
        const { p, map, rows, entries } = await init(false, order);
        const cold = rows();

        p.reload();
        p.config.strict.strictImportMap = true;
        const warm = await p.runInit(entries);

        expect(rows()).toEqual(cold);
        expect(warm).toEqual(map);
        expect(p.config.log.warn).not.toHaveBeenCalled();
      });
    });
  });

  // The host ships fw/testing only, beside r's fw at another tag; r's build lacks fw/testing.
  describe('a host copy the serving build does not cover', () => {
    const shared = (name: string, version: string): DenseSharedInfo =>
      ({
        packageName: name,
        version,
        requiredVersion: `^${version}`,
        singleton: true,
        strictVersion: false,
        entries: { [name]: `${name.replace('/', '_')}.js` },
      }) as DenseSharedInfo;
    const entry = (name: string, ...sharedInfo: DenseSharedInfo[]): RemoteEntry =>
      ({
        name,
        url: `http://${name}/remoteEntry.json`,
        exposes: [],
        shared: sharedInfo,
      }) as unknown as RemoteEntry;

    let storage = 0;
    it.each([true, false])(
      'runs from its own build with its host flag, again on a warm init (host first=%s)',
      async hostFirst => {
        const p = portfolio(
          {},
          { storage: `nf-dsb-host-${storage++}`, realRepositories: true, hosts: ['host'] }
        );
        const host = entry('host', shared('fw/testing', '1.0.0'));
        const r = entry('r', shared('fw', '2.0.0'));
        const entries = hostFirst ? [host, r] : [r, host];
        const rows = () =>
          Object.fromEntries(
            Object.entries(p.stored()).map(([name, e]) => [
              name,
              e.versions.map(v => `${v.tag}:${v.action}:${v.host}:[${v.remotes.map(c => c.name)}]`),
            ])
          );

        const cold = await p.runInit(entries);
        const stored = rows();
        p.reload();
        const warm = await p.runInit(entries);

        expect(stored).toEqual({
          fw: ['2.0.0:share:false:[r]'],
          'fw/testing': ['1.0.0:scope:true:[host]'],
        });
        expect(cold.imports).toEqual({ fw: 'http://r/fw.js' });
        expect(rows()).toEqual(stored);
        expect(warm).toEqual(cold);

        // Re-elected, the host's scope row turns back into its tag's lead row, and falls back again.
        p.reload();
        const reelected = await p.touch('fw/testing');

        expect(rows()).toEqual(stored);
        expect(reelected).toEqual(cold);
      }
    );
  });

  describe('on a second run', () => {
    beforeEach(() =>
      seed({
        fw: [row('fw', '2.0.0', 'share', [shipsAll])],
        'fw/testing': [row('fw/testing', '1.0.0', 'share', [{ remote: 'b', strict: true }])],
        'fw/other': [row('fw/other', '1.5.0', 'share', [{ remote: 'c' }])],
        gone: {
          dirty: false,
          servingBuild: 'x',
          versions: [row('gone', '1.0.0', 'scope', [{ remote: 'x', strict: true }])],
        },
      })
    );

    it('writes nothing', async () => {
      await decide();
      const addOrUpdate = vi.spyOn(adapters.sharedExternalsRepo, 'addOrUpdate');

      await decide();

      expect(addOrUpdate).not.toHaveBeenCalled();
    });

    it('decides what the first run decided', async () => {
      await decide();
      const first = structuredClone(stored());

      await decide();

      expect(stored()).toEqual(first);
    });
  });
});
