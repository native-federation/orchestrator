import type { DrivingContract } from '../driving-ports/driving.contract';
import type { ForExposingModuleLoader } from '../driver-ports/init/for-exposing-module-loader.port';
import type { LoadRemoteModule, PreloadRemoteModule } from 'lib/core/init-federation.contract';
import { NFError } from 'lib/core/native-federation.error';
import type { LoggingConfig } from '../config/log.contract';
import * as _path from 'lib/utils/path';
import { createPreloadHint } from './preload-hint';

export function createExposeModuleLoader(
  config: LoggingConfig,
  ports: Pick<DrivingContract, 'remoteInfoRepo' | 'browser'>
): ForExposingModuleLoader {
  const preload = createPreloadHint(config.log, ports.browser, 6);

  const loadRemoteModule: LoadRemoteModule = <TModule = unknown>(
    remoteName: string,
    exposedModule: string
  ): Promise<TModule> => {
    try {
      if (!ports.remoteInfoRepo.contains(remoteName)) {
        throw new NFError(`Remote '${remoteName}' is not initialized.`);
      }

      const remoteModuleUrl = ports.remoteInfoRepo
        .tryGetModule(remoteName, exposedModule)
        .orThrow(
          new NFError(
            `Exposed module '${exposedModule}' from remote '${remoteName}' not found in storage.`
          )
        );

      config.log.debug(6, `Loading initialized module '${remoteModuleUrl}'`);

      // The import fetches the module itself in the same tick; listing it again would only add a link.
      preload(() => ports.remoteInfoRepo.getModuleChunkUrls(remoteName, exposedModule));
      return ports.browser.importModule(remoteModuleUrl) as Promise<TModule>;
    } catch (error) {
      config.log.error(6, `Failed to load module ${_path.join(remoteName, exposedModule)}: `, {
        error,
      });

      return Promise.reject(
        new NFError(`Failed to load module ${_path.join(remoteName, exposedModule)}`)
      );
    }
  };

  // Apps call this speculatively, on hover or with route data of any shape, so even the lookup runs inside the
  // hint's guard, and an unknown module is a debug line rather than a warning.
  const preloadRemoteModule: PreloadRemoteModule = (remoteName, exposedModule) =>
    preload(() => {
      const url = ports.remoteInfoRepo.tryGetModule(remoteName, exposedModule);
      if (!url.isPresent()) {
        config.log.debug(6, `Nothing to preload for '${remoteName}/${exposedModule}'.`);
        return [];
      }
      return [url.get()!, ...ports.remoteInfoRepo.getModuleChunkUrls(remoteName, exposedModule)];
    });

  /**
   * Step 6: expose module loader
   *
   * The module loader can only be used after the importmap was generated and added to
   * the DOM, hence the module loader fn is exposed to the host after the final commit
   * step.
   *
   * The loadRemoteModule is also a callback that is returned as a promise by the initFederation
   * function. This way the loadRemoteModule can be shared througout the host application using
   * CustomEvents or by adding it to the global Window object for easy access.
   *
   * @param adapters
   */
  return () => Promise.resolve({ loadRemoteModule, preloadRemoteModule });
}
