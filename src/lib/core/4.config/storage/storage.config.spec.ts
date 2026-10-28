import { describe, it, expect, beforeEach } from 'vitest';
import { createStorageConfig } from './storage.config';
import { globalThisStorageEntry } from './global-this.storage';
import { ORCHESTRATOR_VERSION } from 'lib/core/4.config/orchestrator-version';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createRemoteInfoRepository } from 'lib/core/3.adapters/storage/remote-info.repository';
import { createMockLogHandler } from 'lib/testing/handlers/log.handler';
import { createCacheState } from 'lib/core/3.adapters/storage/cache-state';
import type { StorageEntryCreator } from 'lib/core/2.app/config/storage.contract';

const NAMESPACE = '__NF_VERSION_STAMP_SPEC__';
const raw = () => (globalThis as unknown as Record<string, Record<string, unknown>>)[NAMESPACE]!;
const create = (clearStorage?: boolean) =>
  createStorageConfig(
    {
      storage: globalThisStorageEntry,
      storageNamespace: NAMESPACE,
      exposeStorageGetter: false,
      clearStorage,
    },
    createMockLogHandler()
  );

// A cache with no `cache-state`, and a pool verdict whose cause no longer exists.
const seedUnstampedCache = () => {
  (globalThis as unknown as Record<string, unknown>)[NAMESPACE] = {
    remotes: { 'team/mfe1': { scopeUrl: 'http://mfe1/', exposes: [] } },
    'shared-externals': {
      __GLOBAL__: {
        '@angular/core': {
          dirty: false,
          versions: [
            {
              tag: '19.2.15',
              host: false,
              action: 'scope',
              remotes: [
                {
                  name: 'team/mfe1',
                  file: 'core.js',
                  requiredVersion: '^19.0.0',
                  strictVersion: false,
                  cached: true,
                  poolCause: 'torn',
                },
              ],
            },
          ],
        },
      },
    },
  };
};

const coldInit = (config: ReturnType<typeof create>) => {
  expect(config.clearStorage).toBe(true);
  expect(createSharedExternalsRepository(config).getFromScope()).toEqual({});
  // The remotes go too, or a warm init would skip refetching them and never refill the externals.
  expect(createRemoteInfoRepository(config).tryGet('team/mfe1').isPresent()).toBe(false);
};

// vitest defines __NF_ORCHESTRATOR_VERSION__ from package.json, as build.js does, so this is a real release
// version here rather than the 'dev' an unbundled build reports.
describe('createStorageConfig: orchestrator version stamp', () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[NAMESPACE];
  });

  const stamp = () => (raw()['cache-state'] as { version?: unknown } | undefined)?.version;
  const stampCurrent = (o: object = {}) =>
    (raw()['cache-state'] = { version: ORCHESTRATOR_VERSION, undecidedScopes: [], ...o });

  const warmInit = (config: ReturnType<typeof create>) => {
    expect(config.clearStorage).toBe(false);
    expect(createRemoteInfoRepository(config).tryGet('team/mfe1').isPresent()).toBe(true);
  };

  it('stamps the running orchestrator version', () => {
    expect(ORCHESTRATOR_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    create();
    expect(raw()['cache-state']).toEqual({ version: ORCHESTRATOR_VERSION, undecidedScopes: [] });
  });

  it('keeps an empty storage as is', () => {
    expect(create().clearStorage).toBe(false);
  });

  it('keeps a cache the same version wrote: the next init is warm', () => {
    seedUnstampedCache();
    stampCurrent();
    warmInit(create());
  });

  it('keeps the undecided scopes the last page stored', () => {
    seedUnstampedCache();
    stampCurrent({ undecidedScopes: ['team'] });
    const config = create();

    expect(raw()['cache-state']).toEqual({
      version: ORCHESTRATOR_VERSION,
      undecidedScopes: ['team'],
    });
    expect(createSharedExternalsRepository(config).isUndecided('team')).toBe(true);
  });

  it('drops a cache that has records but no cache-state', () => {
    seedUnstampedCache();
    coldInit(create());
    expect(stamp()).toBe(ORCHESTRATOR_VERSION);
  });

  // Another release, an unbundled 'dev' build, or anything that is not a version string.
  it.each(['0.0.1', '99.0.0', 'dev', 1])('drops a cache stamped %s', other => {
    seedUnstampedCache();
    stampCurrent({ version: other, undecidedScopes: ['team'] });
    coldInit(create());
    expect(raw()['cache-state']).toEqual({ version: ORCHESTRATOR_VERSION, undecidedScopes: [] });
  });

  it.each([
    ['a string', '4.8.0'],
    ['null', null],
    ['an array', [ORCHESTRATOR_VERSION]],
  ])('drops a cache whose cache-state is %s', (_, state) => {
    seedUnstampedCache();
    raw()['cache-state'] = state;
    coldInit(create());
    expect(stamp()).toBe(ORCHESTRATOR_VERSION);
  });

  it('drops a cache that only carries the prerelease schema stamp', () => {
    seedUnstampedCache();
    raw()['schema'] = 1;
    coldInit(create());
  });

  it('only drops once: the next init finds the stamp', () => {
    seedUnstampedCache();
    create();
    warmInit(create());
  });

  it('still honours an explicit clearStorage, and keeps the version stamp', () => {
    seedUnstampedCache();
    stampCurrent({ undecidedScopes: ['team'] });
    coldInit(create(true));
    expect(raw()['cache-state']).toEqual({ version: ORCHESTRATOR_VERSION, undecidedScopes: [] });
  });
});

describe('createStorageConfig: write failures', () => {
  // A custom storage over the same globalThis namespace whose writes throw for the listed keys. A plain Error
  // rather than a DOMException pins that any failed write is handled, not only a quota error.
  const failing = new Set<string>();
  const failingStorage: StorageEntryCreator = namespace => {
    const inner = globalThisStorageEntry(namespace);
    return <T>(key: string, initialValue: T) => {
      const entry = inner(key, initialValue);
      const guard = () => {
        if (failing.has(key)) throw new Error(`cannot write ${key}`);
      };
      return {
        get: entry.get,
        set: (value: T) => (guard(), entry.set(value)),
        clear: () => (guard(), entry.clear()),
      };
    };
  };

  let log: ReturnType<typeof createMockLogHandler>;
  const createFailing = () =>
    createStorageConfig(
      { storage: failingStorage, storageNamespace: NAMESPACE, exposeStorageGetter: false },
      log
    );
  const mfe1 = { scopeUrl: 'http://mfe1/', exposes: [] } as never;
  const mfe2 = { scopeUrl: 'http://mfe2/', exposes: [] } as never;

  beforeEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[NAMESPACE];
    failing.clear();
    log = createMockLogHandler();
    seedUnstampedCache();
    raw()['cache-state'] = { version: ORCHESTRATOR_VERSION, undecidedScopes: [] };
  });

  it('keeps the value that failed to persist, on an entry opened before the failure', () => {
    // Repositories open their entries at construction, before any commit.
    const remotes = createRemoteInfoRepository(createFailing());
    failing.add('remotes');

    expect(() => remotes.addOrUpdate('team/mfe2', mfe2).commit()).not.toThrow();

    expect(Object.keys(raw()['remotes'] as object)).toEqual(['team/mfe1']);
    expect(remotes.rollback().contains('team/mfe2')).toBe(true);
  });

  it('unstamps the cache, so the next page starts cold', () => {
    const config = createFailing();
    failing.add('remotes');
    createRemoteInfoRepository(config).addOrUpdate('team/mfe2', mfe2).commit();

    expect(raw()['cache-state']).toBeNull();
    failing.clear();
    coldInit(create());
  });

  it('keeps every later write in memory, so nothing re-stamps the cache', () => {
    const config = createFailing();
    const chunks = config.storage<Record<string, unknown>>('shared-chunks', {});
    failing.add('remotes');
    createRemoteInfoRepository(config).addOrUpdate('team/mfe2', mfe2).commit();
    failing.clear();

    chunks.set({ team: ['chunk.js'] });
    createCacheState(config.storage).update({ version: ORCHESTRATOR_VERSION });

    expect(raw()['shared-chunks']).toBeUndefined();
    expect(raw()['cache-state']).toBeNull();
    expect(chunks.get()).toEqual({ team: ['chunk.js'] });
    expect(createCacheState(config.storage).read().version).toBe(ORCHESTRATOR_VERSION);
    coldInit(create());
  });

  it('warns once, at the commit step, with the key and the error', () => {
    const config = createFailing();
    failing.add('remotes').add('shared-chunks');
    createRemoteInfoRepository(config).addOrUpdate('team/mfe2', mfe2).commit();
    config.storage('shared-chunks', {}).set({});

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      5,
      "Could not save 'remotes' to storage; this page runs from memory and the next page starts without a cache.",
      new Error('cannot write remotes')
    );
  });

  it('swallows a failing invalidation write', () => {
    const config = createFailing();
    failing.add('remotes').add('cache-state');

    expect(() =>
      createRemoteInfoRepository(config).addOrUpdate('team/mfe2', mfe2).commit()
    ).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('survives a failing version stamp at startup and still runs cold', () => {
    delete raw()['cache-state'];
    failing.add('cache-state');

    const config = createFailing();

    coldInit(config);
    expect(log.warn).toHaveBeenCalledWith(
      5,
      expect.stringContaining("'cache-state'"),
      expect.any(Error)
    );
  });

  it("survives a failing clear on the outdated-cache path, the next page's own cleanup", () => {
    raw()['cache-state'] = null;
    failing.add('shared-externals');

    const config = createFailing();

    expect(() => coldInit(config)).not.toThrow();
    expect(raw()['shared-externals']).not.toEqual({ __GLOBAL__: {} });
  });
});
