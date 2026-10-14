import type { RemoteEntry } from 'lib/core/1.domain';
import type { FLOW_FACTORY } from '../driver-ports/flow-factory.contract';
import type { InitDriversContract } from '../driver-ports/init/drivers.contract';
import type { InitRemoteEntryFlow, RemoteRef } from '../driver-ports/init/flow.contract';

export const createInitRemoteEntryFlow = ({
  flow,
  adapters,
  beforeRollback,
}: FLOW_FACTORY<InitDriversContract>): InitRemoteEntryFlow => {
  const processDynamicRemoteEntry = (remoteEntry: RemoteEntry) =>
    flow
      .updateCache(remoteEntry)
      .then(flow.poolDynamicExternals)
      .then(flow.convertToImportMap)
      .then(flow.commitChanges);

  const notifyBeforeRollback = (remoteEntryUrl: string, remote?: RemoteRef) => {
    try {
      beforeRollback?.(remoteEntryUrl, remote);
    } catch {
      // The hook only observes: its failure must neither skip the rollback nor replace the load's error.
    }
  };

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
        notifyBeforeRollback(remoteEntryUrl, remote);
        rollbackRepositories();
        throw error;
      });
};
