import type { ConfigContract } from 'lib/core/2.app/config';
import type { SharedExternal, SharedVersion, SharedVersionAction } from 'lib/core/1.domain';
import { GLOBAL_SCOPE } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { NFError } from 'lib/core/native-federation.error';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
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

    it('stores no serving build without a winner, and keeps the rows', async () => {
      seedPool();

      await decide();

      expect(stored().fw!.versions).toEqual(versions.fw);
      expect(stored()['fw/testing']!.versions).toEqual(versions['fw/testing']);
      expect('servingBuild' in stored().fw!).toBe(false);
      expect('servingBuild' in stored()['fw/testing']!).toBe(false);
    });
  });

  it('redirects a secondary that has a share row of its own at the serving tag', async () => {
    seed({
      fw: [row('fw', '2.0.0', 'share', [{ remote: 'a' }])],
      'fw/testing': [
        row('fw/testing', '2.0.0', 'share', [{ remote: 'e' }]),
        row('fw/testing', '1.0.0', 'share', [{ remote: 'b' }]),
      ],
    });

    await decide();

    expect(rowsOf('fw/testing')).toEqual(['2.0.0:share:[e]', '1.0.0:skip:[b]']);
  });

  it('leaves a secondary that would resolve nowhere at the serving tag on its own share row', async () => {
    const lone = [row('fw/lone', '1.0.0', 'share', [{ remote: 'd', strict: true }])];
    seed({
      fw: [row('fw', '2.0.0', 'share', [{ remote: 'a' }])],
      // Already carries the field, so only a row move would write it.
      'fw/lone': { dirty: false, servingBuild: 'a', versions: structuredClone(lone) },
    });
    config.strict.strictExternalCompatibility = true;
    const addOrUpdate = vi.spyOn(adapters.sharedExternalsRepo, 'addOrUpdate');

    await decide();

    expect(stored()['fw/lone']!.versions).toEqual(lone);
    expect(addOrUpdate).not.toHaveBeenCalledWith('fw/lone', expect.anything(), GLOBAL_SCOPE);
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
