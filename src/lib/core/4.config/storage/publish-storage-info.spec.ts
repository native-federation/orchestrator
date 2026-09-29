import { version } from '../../../../../package.json';
import { publishStorageInfo } from './publish-storage-info';
import { createStorageConfig } from './storage.config';
import { globalThisStorageEntry } from './global-this.storage';
import { sessionStorageEntry } from './session.storage';
import type {
  StorageEntryCreator,
  StorageEntryHandler,
} from 'lib/core/2.app/config/storage.contract';

// In-memory handler so `get` can be exercised without touching real storage.
const memoryHandler = (data: Record<string, unknown>): StorageEntryHandler =>
  (<T>(key: string, initialValue: T) => ({
    get: () => (key in data ? data[key] : initialValue),
    set: vi.fn(),
    clear: vi.fn(),
  })) as StorageEntryHandler;

describe('publishStorageInfo', () => {
  beforeEach(() => {
    delete globalThis.__NF_ORCHESTRATOR__;
  });

  it('publishes the version, namespace, type and keys', () => {
    publishStorageInfo('localStorage', '__custom__', memoryHandler({}));

    expect(globalThis.__NF_ORCHESTRATOR__).toEqual({
      version,
      storage: {
        __custom__: {
          type: 'localStorage',
          namespace: '__custom__',
          keys: ['remotes', 'shared-externals', 'scoped-externals', 'shared-chunks'],
          get: expect.any(Function),
        },
      },
    });
  });

  it('keeps earlier namespaces when a second one is published', () => {
    publishStorageInfo('localStorage', 'first', memoryHandler({}));
    publishStorageInfo('sessionStorage', 'second', memoryHandler({}));

    expect(Object.keys(globalThis.__NF_ORCHESTRATOR__!.storage)).toEqual(['first', 'second']);
  });

  it('is frozen all the way down', () => {
    publishStorageInfo('localStorage', 'ns', memoryHandler({}));
    const published = globalThis.__NF_ORCHESTRATOR__!;

    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.storage)).toBe(true);
    expect(Object.isFrozen(published.storage['ns'])).toBe(true);
    expect(Object.isFrozen(published.storage['ns']!.keys)).toBe(true);
  });

  describe('get', () => {
    it('reads a known key through the storage handler', () => {
      publishStorageInfo('custom', 'ns', memoryHandler({ remotes: { 'team/mfe1': {} } }));

      expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.get('remotes')).toEqual({
        'team/mfe1': {},
      });
    });

    it('returns undefined for a known key that was never written', () => {
      publishStorageInfo('custom', 'ns', memoryHandler({}));

      expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.get('remotes')).toBeUndefined();
    });

    it('does not read keys outside the published set', () => {
      const handler = vi.fn(memoryHandler({ secret: 'x' })) as unknown as StorageEntryHandler;
      publishStorageInfo('custom', 'ns', handler);

      expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.get('secret')).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    });

    it('hands out a copy, so callers cannot mutate the stored state', () => {
      // A custom storage returning its live object: the clone in `get` is the only guard.
      const live = { remotes: { 'team/mfe1': { scopeUrl: 'http://a/' } } };
      publishStorageInfo('custom', 'ns', memoryHandler(live));

      const read = globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.get('remotes') as Record<
        string,
        { scopeUrl: string }
      >;
      read['team/mfe1']!.scopeUrl = 'http://evil/';

      expect(live.remotes['team/mfe1'].scopeUrl).toBe('http://a/');
    });
  });
});

describe('createStorageConfig', () => {
  beforeEach(() => {
    delete globalThis.__NF_ORCHESTRATOR__;
    delete (globalThis as any)['__NATIVE_FEDERATION__'];
  });

  it('publishes the default globalThis storage under the default namespace', () => {
    createStorageConfig({});

    expect(globalThis.__NF_ORCHESTRATOR__!.storage).toEqual({
      __NATIVE_FEDERATION__: expect.objectContaining({
        type: 'globalThis',
        namespace: '__NATIVE_FEDERATION__',
      }),
    });
  });

  it('publishes the configured storage and namespace', () => {
    createStorageConfig({ storage: sessionStorageEntry, storageNamespace: '__mine__' });

    expect(globalThis.__NF_ORCHESTRATOR__!.storage['__mine__']!.type).toBe('sessionStorage');
  });

  it('reports untagged storages as custom', () => {
    const custom: StorageEntryCreator = () => memoryHandler({});
    createStorageConfig({ storage: custom, storageNamespace: 'ns' });

    expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.type).toBe('custom');
  });

  it('get reads what the orchestrator committed to the configured storage', () => {
    const { storage } = createStorageConfig({ storage: globalThisStorageEntry });
    storage('remotes', {}).set({ 'team/mfe1': { scopeUrl: 'http://a/' } });

    expect(
      globalThis.__NF_ORCHESTRATOR__!.storage['__NATIVE_FEDERATION__']!.get('remotes')
    ).toEqual({
      'team/mfe1': { scopeUrl: 'http://a/' },
    });
  });
});
