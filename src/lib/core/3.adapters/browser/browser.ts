import type { ForBrowserTasks } from 'lib/core/2.app/driving-ports/for-browser-tasks';
import type { ImportMapConfig } from 'lib/core/2.app/config/import-map.contract';

const createBrowser = (config: ImportMapConfig): ForBrowserTasks => {
  return {
    setImportMapFn: config.setImportMapFn,
    importModule: config.loadModuleFn,
    preloadModules: config.preloadModulesFn,
  };
};

export { createBrowser };
