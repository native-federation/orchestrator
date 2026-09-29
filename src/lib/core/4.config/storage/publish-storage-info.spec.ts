import { version } from '../../../../../package.json';
import { publishStorageInfo } from './publish-storage-info';
import { createStorageConfig } from './storage.config';
import { globalThisStorageEntry } from './global-this.storage';
import { localStorageEntry } from './local.storage';
import { sessionStorageEntry } from './session.storage';
import type { StorageEntryCreator } from 'lib/core/2.app/config/storage.contract';

describe('publishStorageInfo', () => {
  beforeEach(() => {
    delete globalThis.__NF_ORCHESTRATOR__;
  });

  it('publishes the version, namespace, type and keys', () => {
    publishStorageInfo(localStorageEntry, '__custom__');

    expect(globalThis.__NF_ORCHESTRATOR__).toEqual({
      version,
      storage: {
        __custom__: {
          type: 'localStorage',
          namespace: '__custom__',
          keys: ['remotes', 'shared-externals', 'scoped-externals', 'shared-chunks'],
        },
      },
    });
  });

  it('tags each built-in storage with its type', () => {
    publishStorageInfo(globalThisStorageEntry, 'a');
    publishStorageInfo(sessionStorageEntry, 'b');

    expect(globalThis.__NF_ORCHESTRATOR__!.storage['a']!.type).toBe('globalThis');
    expect(globalThis.__NF_ORCHESTRATOR__!.storage['b']!.type).toBe('sessionStorage');
  });

  it('reports untagged storages as custom', () => {
    const custom: StorageEntryCreator = () => vi.fn();
    publishStorageInfo(custom, 'ns');

    expect(globalThis.__NF_ORCHESTRATOR__!.storage['ns']!.type).toBe('custom');
  });

  it('keeps earlier namespaces when a second one is published', () => {
    publishStorageInfo(localStorageEntry, 'first');
    publishStorageInfo(sessionStorageEntry, 'second');

    expect(Object.keys(globalThis.__NF_ORCHESTRATOR__!.storage)).toEqual(['first', 'second']);
  });

  it('is frozen all the way down', () => {
    publishStorageInfo(localStorageEntry, 'ns');
    const published = globalThis.__NF_ORCHESTRATOR__!;

    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.storage)).toBe(true);
    expect(Object.isFrozen(published.storage['ns'])).toBe(true);
    expect(Object.isFrozen(published.storage['ns']!.keys)).toBe(true);
  });
});

describe('createStorageConfig', () => {
  beforeEach(() => {
    delete globalThis.__NF_ORCHESTRATOR__;
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
});
