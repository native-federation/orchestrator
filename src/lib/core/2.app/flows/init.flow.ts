import type { FLOW_FACTORY } from '../driver-ports/flow-factory.contract';
import type { InitDriversContract } from '../driver-ports/init/drivers.contract';
import type { InitFlow } from '../driver-ports/init/flow.contract';

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
      .then(importMap => flow.commitChanges(importMap, { override: true }))
      .then(flow.exposeModuleLoader)
      .then(loadRemoteModule => ({
        config,
        adapters,
        loadRemoteModule,
      }));
};
