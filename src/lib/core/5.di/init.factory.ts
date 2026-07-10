import type { FLOW_FACTORY } from 'lib/core/2.app/driver-ports/flow-factory.contract';
import type { InitDriversContract } from 'lib/core/2.app/driver-ports/init/drivers.contract';
import { createGetRemoteEntries } from '../2.app/steps/get-remote-entries';
import { createProcessRemoteEntries } from '../2.app/steps/process-remote-entries';
import { createDetermineSharedExternals } from '../2.app/steps/determine-shared-externals';
import { createPoolSharedExternals } from '../2.app/steps/pooling/pool-shared-externals';
import { createGenerateImportMap } from '../2.app/steps/generate-import-map';
import { createCommitChanges } from '../2.app/steps/commit-changes';
import { createExposeModuleLoader } from '../2.app/steps/expose-module-loader';
import { createGetRemoteEntry } from '../2.app/steps/get-remote-entry';
import { createUpdateCache } from '../2.app/steps/update-cache';
import { createPoolDynamicExternals } from '../2.app/steps/pooling/pool-dynamic-externals';
import { createConvertToImportMap } from '../2.app/steps/convert-to-import-map';
import type { DrivingContract } from '../2.app/driving-ports/driving.contract';
import type { ConfigContract } from '../2.app/config/config.contract';

export const createInitDrivers = ({
  config,
  adapters,
}: {
  config: ConfigContract;
  adapters: DrivingContract;
}): InitDriversContract => ({
  getRemoteEntries: createGetRemoteEntries(config, adapters),
  processRemoteEntries: createProcessRemoteEntries(config, adapters),
  determineSharedExternals: createDetermineSharedExternals(config, adapters),
  poolSharedExternals: createPoolSharedExternals(config, adapters),
  generateImportMap: createGenerateImportMap(config, adapters),
  commitChanges: createCommitChanges(config, adapters),
  exposeModuleLoader: createExposeModuleLoader(config, adapters),
  getRemoteEntry: createGetRemoteEntry(config, adapters),
  updateCache: createUpdateCache(config, adapters),
  poolDynamicExternals: createPoolDynamicExternals(config),
  convertToImportMap: createConvertToImportMap(config, adapters),
});

export const INIT_FLOW_FACTORY = ({
  config,
  adapters,
}: {
  config: ConfigContract;
  adapters: DrivingContract;
}): FLOW_FACTORY<InitDriversContract> => {
  const flow = createInitDrivers({ config, adapters });

  return {
    flow,
    adapters,
    config,
  };
};
