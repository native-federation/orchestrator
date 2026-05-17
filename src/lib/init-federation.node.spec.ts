/**
 * @jest-environment node
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ImportMap } from 'lib/1.domain';

// Stub the Node loader client so initNodeFederation never touches module.register.
const mockNodeLoader = {
  setMap: jest.fn<Promise<void>, [ImportMap]>(),
  ready: jest.fn<Promise<void>, []>(),
};

jest.mock('lib/3.adapters/node/node-loader.client', () => ({
  getNodeLoaderClient: () => mockNodeLoader,
}));

import { initNodeFederation } from './init-federation.node';

const writeJson = async (path: string, payload: unknown): Promise<void> => {
  await writeFile(path, JSON.stringify(payload), 'utf-8');
};

describe('initNodeFederation', () => {
  let dir: string;
  let manifestPath: string;
  let hostEntryPath: string;
  let remoteEntryPath: string;

  beforeEach(async () => {
    mockNodeLoader.setMap.mockResolvedValue(undefined);
    mockNodeLoader.ready.mockResolvedValue(undefined);

    dir = await mkdtemp(join(tmpdir(), 'nf-init-'));
    await mkdir(join(dir, 'remote-a'));

    manifestPath = join(dir, 'federation.manifest.json');
    hostEntryPath = join(dir, 'host', 'remoteEntry.json');
    remoteEntryPath = join(dir, 'remote-a', 'remoteEntry.json');

    await mkdir(join(dir, 'host'));
    await writeJson(hostEntryPath, {
      name: '__NF-HOST__',
      exposes: [],
      shared: [],
      shared_externals: [],
    });
    await writeJson(remoteEntryPath, {
      name: 'team/remote-a',
      exposes: [{ key: './Hello', outFileName: 'hello.mjs' }],
      shared: [],
      shared_externals: [],
    });
    await writeJson(manifestPath, {
      'team/remote-a': pathToFileURL(remoteEntryPath).href,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a result with loadRemoteModule after consuming an on-disk manifest', async () => {
    const loadModuleFn = jest.fn().mockResolvedValue({ greet: () => 'hi' });

    const result = await initNodeFederation(pathToFileURL(manifestPath).href, {
      hostRemoteEntry: pathToFileURL(hostEntryPath).href,
      loadModuleFn,
    });

    expect(typeof result.loadRemoteModule).toBe('function');
    expect(typeof result.initRemoteEntry).toBe('function');
  });

  it('posts the generated import map to the Node loader client', async () => {
    await initNodeFederation(pathToFileURL(manifestPath).href, {
      hostRemoteEntry: pathToFileURL(hostEntryPath).href,
      loadModuleFn: jest.fn(),
    });

    expect(mockNodeLoader.setMap).toHaveBeenCalledTimes(1);
    const sentMap = mockNodeLoader.setMap.mock.calls[0]![0];
    expect(sentMap.imports).toEqual(
      expect.objectContaining({
        'team/remote-a/./Hello': expect.stringMatching(/remote-a\/hello\.mjs$/),
      })
    );
  });

  it('awaits nodeLoader.ready() before returning', async () => {
    let resolveReady: () => void = () => undefined;
    mockNodeLoader.ready.mockReturnValue(new Promise<void>(r => (resolveReady = r)));

    let resolved = false;
    const pending = initNodeFederation(pathToFileURL(manifestPath).href, {
      hostRemoteEntry: pathToFileURL(hostEntryPath).href,
      loadModuleFn: jest.fn(),
    }).then(r => {
      resolved = true;
      return r;
    });

    // Let microtasks flush — nodeLoader.ready is pending, init must not resolve.
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    resolveReady();
    await pending;
    expect(resolved).toBe(true);
  });

  it('loadRemoteModule delegates to the configured loadModuleFn with the resolved URL', async () => {
    const loadModuleFn = jest.fn().mockResolvedValue({ greet: () => 'hi' });

    const { loadRemoteModule } = await initNodeFederation(pathToFileURL(manifestPath).href, {
      hostRemoteEntry: pathToFileURL(hostEntryPath).href,
      loadModuleFn,
    });

    const module = await loadRemoteModule('team/remote-a', './Hello');

    expect(loadModuleFn).toHaveBeenCalledWith(
      expect.stringMatching(/remote-a\/hello\.mjs$/)
    );
    expect(module).toEqual({ greet: expect.any(Function) });
  });

  it('rejects when the manifest cannot be read', async () => {
    await expect(
      initNodeFederation('file:///definitely/does/not/exist.json', {
        hostRemoteEntry: pathToFileURL(hostEntryPath).href,
        loadModuleFn: jest.fn(),
      })
    ).rejects.toThrow();
  });

  it('accepts an inline manifest object (no fs read)', async () => {
    await initNodeFederation(
      { 'team/remote-a': pathToFileURL(remoteEntryPath).href },
      {
        hostRemoteEntry: pathToFileURL(hostEntryPath).href,
        loadModuleFn: jest.fn(),
      }
    );

    expect(mockNodeLoader.setMap).toHaveBeenCalled();
  });
});
