import type { RemoteEntry } from 'lib/core/1.domain';
import type { FLOW_FACTORY } from '../driver-ports/flow-factory.contract';
import type { InitDriversContract } from '../driver-ports/init/drivers.contract';
import type { InitRemoteEntryFlow } from '../driver-ports/init/flow.contract';

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
