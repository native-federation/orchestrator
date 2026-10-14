import type { DrivingContract } from '../../2.app/driving-ports/driving.contract';
import type { ConfigContract } from '../../2.app/config/config.contract';
import type { RemoteRef } from './init/flow.contract';

export type FLOW_FACTORY<TDrivers> = {
  flow: TDrivers;
  adapters: DrivingContract;
  config: ConfigContract;
  // Only initRemoteEntry calls it, with the failed load's records still in place.
  beforeRollback?: (remoteEntryUrl: string, remote?: RemoteRef) => void;
};
