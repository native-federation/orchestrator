import type { DrivingContract } from '../driving-ports/driving.contract';
import type { ForRollingBackChanges } from '../driver-ports/init/for-rolling-back-changes.port';
import type { LoggingConfig } from '../config/log.contract';

export const createStateDump =
  (
    config: LoggingConfig,
    ports: Pick<DrivingContract, 'remoteInfoRepo' | 'sharedExternalsRepo' | 'scopedExternalsRepo'>
  ) =>
  (msg: string): void =>
    config.log.debug(0, msg, {
      remotes: { ...ports.remoteInfoRepo.getAll() },
      'shared-externals': ports.sharedExternalsRepo
        .getScopes({ includeGlobal: true })
        .reduce(
          (acc, scope) => ({ ...acc, [scope]: ports.sharedExternalsRepo.getFromScope(scope) }),
          {}
        ),
      'scoped-externals': ports.scopedExternalsRepo.getAll(),
    });

export function createRollbackChanges(
  config: LoggingConfig,
  ports: Pick<
    DrivingContract,
    'remoteInfoRepo' | 'scopedExternalsRepo' | 'sharedExternalsRepo' | 'sharedChunksRepo'
  >
): ForRollingBackChanges {
  const stateDump = createStateDump(config, ports);

  // The repositories outlive a failed load, so its half-written records would otherwise reach the next commit.
  return label =>
    Promise.resolve().then(() => {
      // The logger is user-supplied: if it throws, the rollback must still run.
      try {
        stateDump(`${label} STATE DUMP`);
      } finally {
        ports.remoteInfoRepo.rollback();
        ports.scopedExternalsRepo.rollback();
        ports.sharedExternalsRepo.rollback();
        ports.sharedChunksRepo.rollback();
      }
    });
}
