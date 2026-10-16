import { describe, it, expect, beforeEach } from 'vitest';
import { createStorageConfig } from './storage.config';
import { globalThisStorageEntry } from './global-this.storage';
import { ORCHESTRATOR_VERSION } from 'lib/core/4.config/orchestrator-version';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createRemoteInfoRepository } from 'lib/core/3.adapters/storage/remote-info.repository';

const NAMESPACE = '__NF_VERSION_STAMP_SPEC__';
const raw = () => (globalThis as unknown as Record<string, Record<string, unknown>>)[NAMESPACE]!;
const create = (clearStorage?: boolean) =>
  createStorageConfig({
    storage: globalThisStorageEntry,
    storageNamespace: NAMESPACE,
    exposeStorageGetter: false,
    clearStorage,
  });

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

// vitest defines __NF_ORCHESTRATOR_VERSION__ from package.json, as build.js does, so this is a real release
// version here rather than the 'dev' an unbundled build reports.
describe('createStorageConfig: orchestrator version stamp', () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[NAMESPACE];
  });

  const stamp = () => (raw()['cache-state'] as { version?: unknown } | undefined)?.version;
  const stampCurrent = (o: object = {}) =>
    (raw()['cache-state'] = { version: ORCHESTRATOR_VERSION, undecidedScopes: [], ...o });

  const coldInit = (config: ReturnType<typeof create>) => {
    expect(config.clearStorage).toBe(true);
    expect(createSharedExternalsRepository(config).getFromScope()).toEqual({});
    // The remotes go too, or a warm init would skip refetching them and never refill the externals.
    expect(createRemoteInfoRepository(config).tryGet('team/mfe1').isPresent()).toBe(false);
  };

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
