import type { RemoteEntry } from 'lib/core/1.domain';
import type { FLOW_FACTORY } from '../driver-ports/flow-factory.contract';
import type { InitDriversContract } from '../driver-ports/init/drivers.contract';
import type { InitFlow } from '../driver-ports/init/flow.contract';

export const createInitFlow = ({
  flow,
  adapters,
  config,
}: FLOW_FACTORY<InitDriversContract>): InitFlow => {
  const transform = config.transformRemoteEntryFn;
  const transformRemoteEntries = (entries: RemoteEntry[]) =>
    transform ? Promise.all(entries.map(entry => transform(entry))) : entries;

  return remotesOrManifestUrl =>
    flow
      .getRemoteEntries(remotesOrManifestUrl)
      .then(transformRemoteEntries)
      .then(flow.processRemoteEntries)
      .then(flow.poolSharedExternals)
      .then(flow.determineSharedExternals)
      .then(flow.decideServingBuilds)
      .then(flow.generateImportMap)
      .then(importMap => flow.commitChanges(importMap, { override: true }))
      .then(flow.exposeModuleLoader)
      .then(access => ({
        config,
        adapters,
        ...access,
      }));
};
