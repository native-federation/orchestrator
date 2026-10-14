import type { LoggingConfig } from 'lib/core/2.app/config/log.contract';
import type { ForRollingBackChanges } from '../driver-ports/init/for-rolling-back-changes.port';
import type { DrivingContract } from '../driving-ports/driving.contract';
import { createRollbackChanges } from './rollback-changes';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockConfig } from 'lib/testing/config.mock';

describe('createRollbackChanges', () => {
  let rollbackChanges: ForRollingBackChanges;
  let config: LoggingConfig;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    vi.mocked(adapters.remoteInfoRepo.getAll).mockReturnValue({});
    vi.mocked(adapters.scopedExternalsRepo.getAll).mockReturnValue({});
    rollbackChanges = createRollbackChanges(config, adapters);
  });

  // Mirrors commit-changes.spec: a fifth repository should fail both.
  it('should roll back all repositories', async () => {
    await rollbackChanges('[label]');

    expect(adapters.remoteInfoRepo.rollback).toHaveBeenCalled();
    expect(adapters.scopedExternalsRepo.rollback).toHaveBeenCalled();
    expect(adapters.sharedExternalsRepo.rollback).toHaveBeenCalled();
    expect(adapters.sharedChunksRepo.rollback).toHaveBeenCalled();
  });

  // The dump has to show what the failed load wrote, so it must come before the rollback wipes it.
  it('should dump the state once, labelled, before rolling back', async () => {
    await rollbackChanges('[dynamic-init][r1]');

    expect(config.log.debug).toHaveBeenCalledTimes(1);
    expect(config.log.debug).toHaveBeenCalledWith(
      0,
      '[dynamic-init][r1] STATE DUMP',
      expect.objectContaining({ remotes: {} })
    );
    const dumpedAt = vi.mocked(config.log.debug).mock.invocationCallOrder[0]!;
    const rolledBackAt = vi.mocked(adapters.remoteInfoRepo.rollback).mock.invocationCallOrder[0]!;
    expect(dumpedAt).toBeLessThan(rolledBackAt);
  });

  it('should still roll back when the logger throws, then reject with its error', async () => {
    vi.mocked(config.log.debug).mockImplementation(() => {
      throw new Error('logger failed');
    });

    await expect(rollbackChanges('[label]')).rejects.toThrow('logger failed');

    expect(adapters.remoteInfoRepo.rollback).toHaveBeenCalled();
    expect(adapters.scopedExternalsRepo.rollback).toHaveBeenCalled();
    expect(adapters.sharedExternalsRepo.rollback).toHaveBeenCalled();
    expect(adapters.sharedChunksRepo.rollback).toHaveBeenCalled();
  });
});
