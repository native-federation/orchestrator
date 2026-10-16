import type { DrivingContract } from '../driving-ports/driving.contract';
import type { ForMarkingUndecidedScopes } from '../driver-ports/init/for-marking-undecided-scopes.port';

// A runtime load decides no serving build, so the next init decides one in every scope the load wrote, whatever
// step wrote it. The strict scope has none.
export function createMarkUndecidedScopes(
  ports: Pick<DrivingContract, 'sharedExternalsRepo'>
): ForMarkingUndecidedScopes {
  return importMap => {
    const repo = ports.sharedExternalsRepo;
    for (const shareScope of repo.uncommittedScopes())
      if (repo.scopeType(shareScope) !== 'strict') repo.markUndecided(shareScope);
    return Promise.resolve(importMap);
  };
}
