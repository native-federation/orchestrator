import type { DrivingContract } from '../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockVersionRemote, newestFirst } from 'lib/testing/domain/externals/version.mock';
import { Optional } from 'lib/utils/optional';
import type { RemoteEntry, RemoteInfo, SharedExternal, SharedVersion } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createDetermineSharedExternals } from './determine-shared-externals';
import { createMarkPoolsForReelection } from './pooling/mark-pools-for-reelection';
import { createPoolSharedExternals } from './pooling/pool-shared-externals';
import { createGenerateImportMap } from './generate-import-map';
import { createUpdateCache } from './update-cache';
import { createPoolDynamicExternals } from './pooling/pool-dynamic-externals';
import { createConvertToImportMap } from './convert-to-import-map';
import { tagSharedInfoByNpmScope, tagStoredByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';

/**
 * A copy always runs the build it ships, so a range that excludes its own version — package.json drifted
 * from the lockfile, e.g. `~19.1.0` while shipping 19.2.15 — must never make that version "incompatible"
 * with it. Before this rule each resolver punished it differently: pooled strict init threw `Could not pool`,
 * unpooled strict init threw once the external had a second version, and the dynamic path scoped the copy —
 * loading a second instance of the identical singleton build — or threw under strict. All fixtures run with
 * `strictExternalCompatibility` on, since that is where the old behaviour threw.
 */
describe('a copy accepts its own version (integration)', () => {
  const SCOPE = {
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
    'team/mfe-c': 'http://mfe-c/',
  } as const;

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    config.strict.strictExternalCompatibility = true;
    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-own-tag-integration'),
      clearStorage: true,
    });

    adapters.remoteInfoRepo.getAll = vi.fn(() => ({}));
    adapters.scopedExternalsRepo.getAll = vi.fn(() => ({}));
    adapters.sharedChunksRepo.tryGet = vi.fn(() => Optional.empty());
    adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
      name in SCOPE
        ? Optional.of({ scopeUrl: SCOPE[name as keyof typeof SCOPE], exposes: [] } as RemoteInfo)
        : Optional.empty<RemoteInfo>()
    );
  });

  const version = (
    tag: string,
    external: string,
    remotes: { remote: string; req: string }[],
    action: SharedVersion['action'] = 'skip'
  ): SharedVersion => ({
    tag,
    host: false,
    action,
    remotes: remotes.map(r =>
      mockVersionRemote(r.remote, external, {
        requiredVersion: r.req,
        strictVersion: true,
        // A committed `share` copy is the one the map already publishes.
        cached: action === 'share',
      })
    ),
  });

  // Scoped packages get their npm-scope pool tag, as the build adds by default; `dep` stays unpooled.
  const seed = (name: string, versions: SharedVersion[], dirty = true) =>
    adapters.sharedExternalsRepo.addOrUpdate(
      name,
      tagStoredByNpmScope({
        [name]: { dirty, versions: newestFirst(versions, adapters.versionCheck.compare) },
      })[name]!,
      undefined
    );

  const runInit = async () => {
    const pooled = await createMarkPoolsForReelection(config, adapters)();
    const touched = await createDetermineSharedExternals(config, adapters)(pooled);
    await createPoolSharedExternals(config, adapters)(touched);
    return createGenerateImportMap(config, adapters)();
  };

  const stored = (name: string): SharedExternal =>
    adapters.sharedExternalsRepo.getFromScope(undefined)[name]!;

  const scopedCopies = (name: string) =>
    stored(name).versions.filter(v => v.action === 'scope').flatMap(v => v.remotes);

  const islandWarnings = () =>
    vi
      .mocked(config.log.warn)
      .mock.calls.filter(([, msg]) => typeof msg === 'string' && msg.includes('is islanded'));

  const drifted = [
    { remote: 'team/mfe-a', req: '~19.1.0' },
    { remote: 'team/mfe-b', req: '~19.1.0' },
  ];

  describe('init', () => {
    it('pools two remotes that ship one build under a range excluding it, without throwing', async () => {
      for (const name of ['@framework/core', '@framework/common'])
        seed(name, [version('19.2.15', name, drifted)]);

      const importMap = await runInit();

      expect(importMap.imports['@framework/core']).toBe('http://mfe-a/@framework/core.js');
      expect(importMap.scopes ?? {}).toEqual({});
      for (const name of ['@framework/core', '@framework/common']) {
        expect(scopedCopies(name)).toEqual([]);
        expect(stored(name).versions.flatMap(v => v.remotes).some(r => r.poolCause)).toBe(false);
      }
      expect(islandWarnings()).toEqual([]);
    });

    it('shares the drifted build unpooled, once the external has a second version too', async () => {
      seed('dep', [
        version('19.2.15', 'dep', drifted),
        version('19.0.0', 'dep', [{ remote: 'team/mfe-c', req: '^19.0.0' }]),
      ]);

      const importMap = await runInit();

      expect(importMap.imports['dep']).toBe('http://mfe-a/dep.js');
      expect(importMap.scopes ?? {}).toEqual({});
      expect(stored('dep').versions.map(v => `${v.tag}:${v.action}`)).toEqual([
        '19.2.15:share',
        '19.0.0:skip',
      ]);
    });

    it('counts a `v`-prefixed tag as the same version as its plain spelling', async () => {
      seed('dep', [
        version('v19.2.15', 'dep', [{ remote: 'team/mfe-a', req: '~19.1.0' }]),
        version('19.2.15', 'dep', [{ remote: 'team/mfe-b', req: '^19.2.0' }]),
      ]);

      await runInit();

      expect(scopedCopies('dep')).toEqual([]);
    });

    it('still refuses a strict range rejecting a version it does not ship', async () => {
      seed('dep', [
        version('19.2.15', 'dep', [{ remote: 'team/mfe-a', req: '^19.0.0' }]),
        version('18.0.0', 'dep', [
          { remote: 'team/mfe-b', req: '~18.0.0' },
          { remote: 'team/mfe-c', req: '~18.0.0' },
        ]),
      ]);

      // 18.0.0 costs one download against 19.2.15's two, and mfe-a's strict ^19 rejects it.

      await expect(runInit()).rejects.toThrow('Could not determine shared externals');
    });
  });

  describe('dynamic init', () => {
    const entryB = (names: string[]): RemoteEntry =>
      ({
        name: 'team/mfe-b',
        url: 'http://mfe-b/remoteEntry.json',
        exposes: [],
        shared: tagSharedInfoByNpmScope(
          names.map(name =>
            mockSharedInfo(name, {
              requiredVersion: '~19.1.0',
              version: '19.2.15',
              singleton: true,
              strictVersion: true,
            })
          )
        ),
      }) as RemoteEntry;

    const runDynamic = async (entry: RemoteEntry) => {
      const updated = await createUpdateCache(config, adapters)(entry);
      const pooled = await createPoolDynamicExternals(config, adapters)(updated);
      return { pooled, importMap: await createConvertToImportMap(config, adapters)(pooled) };
    };

    it('dedups a joiner onto the shared build it ships itself, not a second instance of it', async () => {
      seed('dep', [version('19.2.15', 'dep', [{ remote: 'team/mfe-a', req: '^19.0.0' }], 'share')], false);

      const { pooled, importMap } = await runDynamic(entryB(['dep']));

      expect(pooled.actions['dep']!.action).toBe('skip');
      expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['dep']).toBeUndefined();
      expect(scopedCopies('dep')).toEqual([]);
      // The drift stays visible, it just no longer costs anything.
      expect(config.log.warn).toHaveBeenCalledWith(
        8,
        "[team/mfe-b][dep] requiredVersion '~19.1.0' excludes its own version '19.2.15'; '19.2.15' is still accepted for it."
      );
    });

    it('lets a pooled joiner resolve its family through the committed map', async () => {
      for (const name of ['@framework/core', '@framework/common'])
        seed(
          name,
          [version('19.2.15', name, [{ remote: 'team/mfe-a', req: '^19.0.0' }], 'share')],
          false
        );

      const { pooled, importMap } = await runDynamic(
        entryB(['@framework/core', '@framework/common'])
      );

      for (const name of ['@framework/core', '@framework/common']) {
        expect(pooled.actions[name]!.action).toBe('skip');
        expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.[name]).toBeUndefined();
        expect(scopedCopies(name)).toEqual([]);
      }
      expect(islandWarnings()).toEqual([]);
    });
  });
});
