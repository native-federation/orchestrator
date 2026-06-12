import type { FLOW_FACTORY } from 'lib/core/2.app/driver-ports/flow-factory.contract';
import type { InitDriversContract } from 'lib/core/2.app/driver-ports/init/drivers.contract';
import type { InitFlow, InitRemoteEntryFlow } from 'lib/core/2.app/driver-ports/init/flow.contract';
import type { RemoteEntry } from 'lib/core/1.domain';
import { createGetRemoteEntries } from '../../2.app/flows/init/get-remote-entries';
import { createProcessRemoteEntries } from '../../2.app/flows/init/process-remote-entries';
import { createDetermineSharedExternals } from '../../2.app/flows/init/determine-shared-externals';
import { createGenerateImportMap } from '../../2.app/flows/init/generate-import-map';
import { createCommitChanges } from '../../2.app/flows/init/commit-changes';
import { createExposeModuleLoader } from '../../2.app/flows/init/expose-module-loader';
import { createGetRemoteEntry } from '../../2.app/flows/init/get-remote-entry';
import { createUpdateCache } from '../../2.app/flows/init/update-cache';
import { createConvertToImportMap } from '../../2.app/flows/init/convert-to-import-map';
import type { DrivingContract } from '../../2.app/driving-ports/driving.contract';
import type { ConfigContract } from '../../2.app/config/config.contract';

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
  generateImportMap: createGenerateImportMap(config, adapters),
  commitChanges: createCommitChanges(config, adapters),
  exposeModuleLoader: createExposeModuleLoader(config, adapters),
  getRemoteEntry: createGetRemoteEntry(config, adapters),
  updateCache: createUpdateCache(config, adapters),
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

export const createInitFlow = ({
  flow,
  adapters,
  config,
}: FLOW_FACTORY<InitDriversContract>): InitFlow => {
  return remotesOrManifestUrl =>
    flow
      .getRemoteEntries(remotesOrManifestUrl)
      .then(flow.processRemoteEntries)
      .then(flow.determineSharedExternals)
      .then(flow.generateImportMap)
      .then(flow.commitChanges)
      .then(flow.exposeModuleLoader)
      .then(loadRemoteModule => ({
        config,
        adapters,
        loadRemoteModule,
      }));
};

export const createInitRemoteEntryFlow = ({
  flow,
}: FLOW_FACTORY<InitDriversContract>): InitRemoteEntryFlow => {
  const processDynamicRemoteEntry = (remoteEntry: RemoteEntry) =>
    flow.updateCache(remoteEntry).then(flow.convertToImportMap).then(flow.commitChanges);

  return (remoteEntryUrl, remote) =>
    flow
      .getRemoteEntry(remoteEntryUrl, remote)
      .then(entry => entry.map(processDynamicRemoteEntry).orElse(Promise.resolve()))
      .then(() => undefined);
};
