import { version } from '../../../../../package.json';
import { publishStorageInfo } from './publish-storage-info';
import { createStorageConfig } from './storage.config';
import { globalThisStorageEntry } from './global-this.storage';
import { sessionStorageEntry } from './session.storage';
import { localStorageEntry } from './local.storage';
import type {
  StorageEntryCreator,
  StorageEntryHandler,
  StorageType,
} from 'lib/core/2.app/config/storage.contract';

// In-memory handler so `get` can be exercised without touching real storage.
const memoryHandler = (data: Record<string, unknown>): StorageEntryHandler =>
  (<T>(key: string, initialValue: T) => ({
    get: () => (key in data ? data[key] : initialValue),
    set: vi.fn(),
    clear: vi.fn(),
  })) as StorageEntryHandler;

const publish = (
  type: StorageType,
  namespace: string,
  storage: StorageEntryHandler,
  exposeGetter = true
) => publishStorageInfo({ type, namespace, storage, exposeGetter });

describe('publishStorageInfo', () => {
  beforeEach(() => {
    delete globalThis.__NF_ORCHESTRATOR__;
  });

  it('publishes the version, namespace, type and keys', () => {
    publish('localStorage', '__custom__', memoryHandler({}));

    expect(globalThis.__NF_ORCHESTRATOR__).toEqual({
      storage: {
        __custom__: {
          version,
          type: 'localStorage',
          namespace: '__custom__',
          keys: ['remotes', 'shared-externals', 'scoped-externals', 'shared-chunks'],
          get: expect.any(Function),
        },
      },
    });
  });

  it('keeps earlier namespaces when a second one is published', () => {
    publish('localStorage', 'first', memoryHandler({}));
    publish('sessionStorage', 'second', memoryHandler({}));

    expect(Object.keys(globalThis.__NF_ORCHESTRATOR__!.storage)).toEqual(['first', 'second']);
  });

  it('replaces the entry when the same namespace is published again', () => {
    publish('localStorage', 'ns', memoryHandler({}));
    publish('sessionStorage', 'ns', memoryHandler({}));

    expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.type).toBe('sessionStorage');
  });

  it('keeps the version of each earlier entry instead of one page-wide version', () => {
    // Simulates a different orchestrator bundle that published before this one.
    globalThis.__NF_ORCHESTRATOR__ = {
      storage: { other: { version: '3.0.0', type: 'globalThis', namespace: 'other', keys: [] } },
    };
    publish('localStorage', 'ns', memoryHandler({}));

    expect(globalThis.__NF_ORCHESTRATOR__!.storage['other']!.version).toBe('3.0.0');
    expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.version).toBe(version);
  });

  it('never throws when the global is not writable', () => {
    Object.defineProperty(globalThis, '__NF_ORCHESTRATOR__', {
      value: undefined,
      writable: false,
      configurable: true,
    });
    try {
      expect(() => publish('localStorage', 'ns', memoryHandler({}))).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, '__NF_ORCHESTRATOR__', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    }
  });

  it('never throws when a foreign global has a throwing storage getter', () => {
    globalThis.__NF_ORCHESTRATOR__ = {
      get storage(): never {
        throw new Error('foreign');
      },
    };

    expect(() => publish('localStorage', 'ns', memoryHandler({}))).not.toThrow();
  });

  it('omits get when the host opts out', () => {
    const handler = vi.fn(memoryHandler({})) as unknown as StorageEntryHandler;
    publish('custom', 'ns', handler, false);

    const info = globalThis.__NF_ORCHESTRATOR__!.storage['ns']!;
    expect(info).not.toHaveProperty('get');
    expect(info.keys).toEqual(['remotes', 'shared-externals', 'scoped-externals', 'shared-chunks']);
  });

  it('is frozen all the way down', () => {
    publish('localStorage', 'ns', memoryHandler({}));
    const published = globalThis.__NF_ORCHESTRATOR__!;

    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.storage)).toBe(true);
    expect(Object.isFrozen(published.storage['ns'])).toBe(true);
    expect(Object.isFrozen(published.storage['ns']!.keys)).toBe(true);
  });

  describe('get', () => {
    it('reads a known key through the storage handler', () => {
      publish('custom', 'ns', memoryHandler({ remotes: { 'team/mfe1': {} } }));

      expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.get!('remotes')).toEqual({
        'team/mfe1': {},
      });
    });

    it('returns undefined for a known key that was never written', () => {
      publish('custom', 'ns', memoryHandler({}));

      expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.get!('remotes')).toBeUndefined();
    });

    it('does not read keys outside the published set', () => {
      const handler = vi.fn(memoryHandler({ secret: 'x' })) as unknown as StorageEntryHandler;
      publish('custom', 'ns', handler);

      expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.get!('secret')).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    });

    it('hands out a copy, so callers cannot mutate the stored state', () => {
      // A custom storage returning its live object: the clone in `get` is the only guard.
      const live = { remotes: { 'team/mfe1': { scopeUrl: 'http://a/' } } };
      publish('custom', 'ns', memoryHandler(live));

      const read = globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.get!('remotes') as Record<
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
    delete (globalThis as any)['on'];
    delete (globalThis as any)['off'];
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

  it('reports the type tag of a custom creator', () => {
    const custom: StorageEntryCreator = Object.assign(() => memoryHandler({}), {
      type: 'localStorage' as const,
    });
    createStorageConfig({ storage: custom, storageNamespace: 'ns' });

    expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.type).toBe('localStorage');
  });

  it('exposes get unless exposeStorageGetter is false', () => {
    createStorageConfig({ storageNamespace: 'on' });
    createStorageConfig({ storageNamespace: 'off', exposeStorageGetter: false });

    expect(globalThis.__NF_ORCHESTRATOR__!.storage['on']!.get).toEqual(expect.any(Function));
    expect(globalThis.__NF_ORCHESTRATOR__!.storage['off']!.get).toBeUndefined();
  });

  it('freezes the built-in creators so their type tag cannot be reassigned', () => {
    expect(Object.isFrozen(globalThisStorageEntry)).toBe(true);
    expect(Object.isFrozen(localStorageEntry)).toBe(true);
    expect(Object.isFrozen(sessionStorageEntry)).toBe(true);
  });

  it('get reads what the orchestrator committed to the configured storage', () => {
    const { storage } = createStorageConfig({ storage: globalThisStorageEntry });
    storage('remotes', {}).set({ 'team/mfe1': { scopeUrl: 'http://a/' } });

    expect(
      globalThis.__NF_ORCHESTRATOR__!.storage['__NATIVE_FEDERATION__']!.get!('remotes')
    ).toEqual({
      'team/mfe1': { scopeUrl: 'http://a/' },
    });
  });
});
