import type { RemoteEntry } from 'lib/core/1.domain';
import type { FLOW_FACTORY } from '../driver-ports/flow-factory.contract';
import type { InitDriversContract } from '../driver-ports/init/drivers.contract';
import type { InitRemoteEntryFlow } from '../driver-ports/init/flow.contract';
import { createStateDump } from './state-dump';

export const createInitRemoteEntryFlow = ({
  flow,
  adapters,
  config,
}: FLOW_FACTORY<InitDriversContract>): InitRemoteEntryFlow => {
  const stateDump = createStateDump(config, adapters);

  const processDynamicRemoteEntry = (remoteEntry: RemoteEntry) =>
    flow
      .updateCache(remoteEntry)
      .then(flow.poolDynamicExternals)
      .then(flow.convertToImportMap)
      .then(flow.commitChanges);

  // The repositories outlive this load, so a refused load would otherwise leave its half-written records
  // for the next successful commit to persist.
  const rollbackRepositories = () => {
    adapters.remoteInfoRepo.rollback();
    adapters.scopedExternalsRepo.rollback();
    adapters.sharedExternalsRepo.rollback();
    adapters.sharedChunksRepo.rollback();
  };

  return (remoteEntryUrl, remote) =>
    flow
      .getRemoteEntry(remoteEntryUrl, remote)
      .then(entry => entry.map(processDynamicRemoteEntry).orElse(Promise.resolve()))
      .then(() => undefined)
      .catch((error: unknown) => {
        const remoteName = typeof remote === 'string' ? remote : remote?.name;
        // The logger is user-supplied: if it throws, the rollback must still run.
        try {
          stateDump(`[dynamic-init][${remoteName ?? remoteEntryUrl}] STATE DUMP`);
        } finally {
          rollbackRepositories();
        }
        throw error;
      });
};
