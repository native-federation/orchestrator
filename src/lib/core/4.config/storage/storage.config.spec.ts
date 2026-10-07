import { describe, it, expect, beforeEach } from 'vitest';
import { createStorageConfig } from './storage.config';
import { globalThisStorageEntry } from './global-this.storage';
import { STORAGE_VERSION_KEY } from 'lib/core/2.app/config/storage.contract';
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

// A cache as 4.7.0 left it: no version stamp, a pool verdict whose cause no longer exists.
const seed47Cache = () => {
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

  const coldInit = (config: ReturnType<typeof create>) => {
    expect(config.clearStorage).toBe(true);
    expect(createSharedExternalsRepository(config).getFromScope()).toEqual({});
    // The remotes go too, or a warm init would skip refetching them and never refill the externals.
    expect(createRemoteInfoRepository(config).tryGet('team/mfe1').isPresent()).toBe(false);
  };

  it('stamps the running orchestrator version', () => {
    expect(ORCHESTRATOR_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    create();
    expect(raw()[STORAGE_VERSION_KEY]).toBe(ORCHESTRATOR_VERSION);
  });

  it('keeps an empty storage as is', () => {
    expect(create().clearStorage).toBe(false);
  });

  it('keeps a cache the same version wrote: the next init is warm', () => {
    seed47Cache();
    raw()[STORAGE_VERSION_KEY] = ORCHESTRATOR_VERSION;
    const config = create();

    expect(config.clearStorage).toBe(false);
    expect(createRemoteInfoRepository(config).tryGet('team/mfe1').isPresent()).toBe(true);
  });

  it('drops an unstamped cache, so a 4.7.0 verdict is never published', () => {
    seed47Cache();
    coldInit(create());
    expect(raw()[STORAGE_VERSION_KEY]).toBe(ORCHESTRATOR_VERSION);
  });

  // An older or newer release, an unbundled 'dev' build, or anything that is not a version string.
  it.each(['4.7.9', '99.0.0', 'dev', 1])('drops a cache stamped %s', other => {
    seed47Cache();
    raw()[STORAGE_VERSION_KEY] = other;
    coldInit(create());
    expect(raw()[STORAGE_VERSION_KEY]).toBe(ORCHESTRATOR_VERSION);
  });

  it('drops a cache that only carries the prerelease schema stamp', () => {
    seed47Cache();
    raw()['schema'] = 1;
    coldInit(create());
  });

  it('only drops once: the next init finds the stamp', () => {
    seed47Cache();
    create();
    expect(create().clearStorage).toBe(false);
  });

  it('still honours an explicit clearStorage', () => {
    expect(create(true).clearStorage).toBe(true);
  });
});
