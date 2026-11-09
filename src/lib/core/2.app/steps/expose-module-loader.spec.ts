import { ForExposingModuleLoader } from '../driver-ports/init/for-exposing-module-loader.port';
import { DrivingContract } from '../driving-ports/driving.contract';
import { createExposeModuleLoader } from './expose-module-loader';
import { LoggingConfig } from '../config/log.contract';
import { Optional } from 'lib/utils/optional';
import { NFError } from 'lib/core/native-federation.error';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockConfig } from 'lib/testing/config.mock';
import { createRemoteInfoRepository } from 'lib/core/3.adapters/storage/remote-info.repository';
import { createStorageHandlerMock } from 'lib/testing/handlers/storage.mock';

describe('createExposeModuleLoader', () => {
  let exposeModuleLoader: ForExposingModuleLoader;
  let adapters: Pick<DrivingContract, 'remoteInfoRepo' | 'browser'>;
  let config: LoggingConfig;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();

    exposeModuleLoader = createExposeModuleLoader(config, adapters);
  });

  it('should load a remote module if in storage', async () => {
    adapters.remoteInfoRepo.contains = vi.fn(() => true);
    adapters.remoteInfoRepo.tryGetModule = vi.fn(
      (): Optional<string> => Optional.of('http://my.service/mfe1/component-a.js')
    );

    const { loadRemoteModule } = await exposeModuleLoader();

    await loadRemoteModule('team/mfe1', './component-a');

    expect(adapters.browser.importModule).toHaveBeenCalledWith(
      'http://my.service/mfe1/component-a.js'
    );
  });

  describe('preloading', () => {
    beforeEach(() => {
      adapters.remoteInfoRepo.contains = vi.fn(() => true);
      adapters.remoteInfoRepo.tryGetModule = vi.fn(() =>
        Optional.of('http://my.service/mfe1/component-a.js')
      );
      adapters.remoteInfoRepo.getModuleChunkUrls = vi.fn(() => [
        'http://my.service/mfe1/chunk-A.js',
      ]);
    });

    // The import requests the module itself in the same tick; the hint covers what it would find later.
    it("hints the module's chunks before importing it, never the module", async () => {
      const { loadRemoteModule } = await exposeModuleLoader();

      await loadRemoteModule('team/mfe1', './component-a');

      expect(adapters.browser.preloadModules).toHaveBeenCalledWith([
        'http://my.service/mfe1/chunk-A.js',
      ]);
      expect(vi.mocked(adapters.browser.preloadModules).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(adapters.browser.importModule).mock.invocationCallOrder[0]!
      );
    });

    // The hint's own guard is what keeps this out of the loader's catch, which would report a failed load.
    it('loads and logs no load error when the hint throws', async () => {
      adapters.browser.preloadModules = vi.fn(() => {
        throw new Error('broken host preload');
      });
      adapters.browser.importModule = vi.fn(async () => ({ loaded: true }));
      const { loadRemoteModule } = await exposeModuleLoader();

      await expect(loadRemoteModule('team/mfe1', './component-a')).resolves.toEqual({
        loaded: true,
      });
      expect(config.log.error).not.toHaveBeenCalled();
    });

    // On hover or route intent the import has not started, so the module itself is part of the hint.
    it('preloadRemoteModule hints the module and its chunks, and imports nothing', async () => {
      const { preloadRemoteModule } = await exposeModuleLoader();

      preloadRemoteModule('team/mfe1', './component-a');

      expect(adapters.browser.preloadModules).toHaveBeenCalledWith([
        'http://my.service/mfe1/component-a.js',
        'http://my.service/mfe1/chunk-A.js',
      ]);
      expect(adapters.browser.importModule).not.toHaveBeenCalled();
    });

    it('preloadRemoteModule does nothing but a debug line for an unknown module', async () => {
      adapters.remoteInfoRepo.tryGetModule = vi.fn(() => Optional.empty<string>());
      const { preloadRemoteModule } = await exposeModuleLoader();

      preloadRemoteModule('team/mfe1', './missing');

      expect(adapters.browser.preloadModules).not.toHaveBeenCalled();
      expect(config.log.debug).toHaveBeenCalledWith(
        6,
        "Nothing to preload for 'team/mfe1/./missing'."
      );
      expect(config.log.warn).not.toHaveBeenCalled();
      expect(config.log.error).not.toHaveBeenCalled();
    });

    it('preloadRemoteModule does not throw when the hint does', async () => {
      adapters.browser.preloadModules = vi.fn(() => {
        throw new Error('broken host preload');
      });
      const { preloadRemoteModule } = await exposeModuleLoader();

      expect(() => preloadRemoteModule('team/mfe1', './component-a')).not.toThrow();
    });

    // Route data is untyped, and a remote may be named like an Object.prototype key; none of it may escape.
    it.each([
      ['an undefined remote', undefined, './component-a'],
      ['an undefined module', 'team/mfe1', undefined],
      ['a remote named constructor', 'constructor', './component-a'],
    ])('preloadRemoteModule never throws, for %s', async (_name, remote, module) => {
      adapters.remoteInfoRepo = createRemoteInfoRepository({
        storage: createStorageHandlerMock({
          remotes: {
            'team/mfe1': {
              scopeUrl: 'http://my.service/mfe1/',
              exposes: [{ moduleName: './component-a', file: 'component-a.js' }],
            },
          },
        }),
        clearStorage: false,
      });
      const { preloadRemoteModule } = await createExposeModuleLoader(config, adapters)();

      expect(() => preloadRemoteModule(remote as string, module as string)).not.toThrow();
      expect(adapters.browser.preloadModules).not.toHaveBeenCalled();
    });

    it('sends no hint for a module without chunks', async () => {
      adapters.remoteInfoRepo.getModuleChunkUrls = vi.fn(() => []);
      const { loadRemoteModule } = await exposeModuleLoader();

      await loadRemoteModule('team/mfe1', './component-a');

      expect(adapters.browser.preloadModules).not.toHaveBeenCalled();
    });
  });

  it('should throw an error if remote-info is not in storage', async () => {
    adapters.remoteInfoRepo.contains = vi.fn(() => false);

    const { loadRemoteModule } = await exposeModuleLoader();

    await expect(loadRemoteModule('team/mfe1', './comp-a')).rejects.toEqual(
      new NFError('Failed to load module team/mfe1/./comp-a')
    );

    expect(config.log.error).toHaveBeenCalledWith(6, 'Failed to load module team/mfe1/./comp-a: ', {
      error: new NFError("Remote 'team/mfe1' is not initialized."),
    });
  });

  it('should throw an error if remote-info doesnt contain the module', async () => {
    adapters.remoteInfoRepo.contains = vi.fn(() => true);
    adapters.remoteInfoRepo.tryGetModule = vi.fn((): Optional<string> => Optional.empty());

    const { loadRemoteModule } = await exposeModuleLoader();

    await expect(loadRemoteModule('team/mfe1', './comp-a')).rejects.toEqual(
      new NFError('Failed to load module team/mfe1/./comp-a')
    );

    expect(config.log.error).toHaveBeenCalledWith(6, 'Failed to load module team/mfe1/./comp-a: ', {
      error: new NFError("Exposed module './comp-a' from remote 'team/mfe1' not found in storage."),
    });
  });
});
