import type { ConfigContract } from '../config/config.contract';
import type { DrivingContract } from '../driving-ports/driving.contract';

export const createStateDump =
  (config: ConfigContract, adapters: DrivingContract) =>
  (msg: string): void =>
    config.log.debug(0, msg, {
      remotes: { ...adapters.remoteInfoRepo.getAll() },
      'shared-externals': adapters.sharedExternalsRepo
        .getScopes({ includeGlobal: true })
        .reduce(
          (acc, scope) => ({ ...acc, [scope]: adapters.sharedExternalsRepo.getFromScope(scope) }),
          {}
        ),
      'scoped-externals': adapters.scopedExternalsRepo.getAll(),
    });
