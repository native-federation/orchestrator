import type { DrivingContract } from '../driving-ports/driving.contract';
import type {
  CommitOptions,
  ForCommittingChanges,
} from '../driver-ports/init/for-committing-changes.port';
import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';
import type { LoggingConfig } from 'lib/core/2.app/config';
import { createPreloadHint } from './preload-hint';
import { createCollectEagerPreloads } from './collect-eager-preloads';

export function createCommitChanges(
  config: LoggingConfig,
  ports: Pick<
    DrivingContract,
    | 'remoteInfoRepo'
    | 'scopedExternalsRepo'
    | 'sharedExternalsRepo'
    | 'sharedChunksRepo'
    | 'browser'
  >
): ForCommittingChanges {
  const preload = createPreloadHint(config.log, ports.browser, 5);
  const collectEagerPreloads = createCollectEagerPreloads(ports);

  /**
   * Step 5: Commit all changes
   *
   * The changes made to the storage/cache are persisted to storage, and the importmap is
   * inserted into the HTML DOM.
   *
   * This step only runs if all previous steps were successful to prevent the persistence of
   * erroneous changes into storage which can corrupt other pages/routes of the host. A failed
   * dynamic load is undone by `rollbackChanges` instead.
   *
   * Last, it preloads the externals whose served copy opted in, once the map is in place: a
   * preload issued before the map that resolves it fixes a failed resolution in the browser.
   */
  return (importMap: ImportMap, { markUndecided = false, ...browserOpts }: CommitOptions = {}) =>
    Promise.resolve(importMap)
      .then(map => addToBrowser(map, browserOpts))
      .then(added => {
        if (markUndecided) markUndecidedScopes();
        persistRepositoryChanges();
        preloadOnceAdded(added, importMap);
      });

  function addToBrowser(importMap: ImportMap, opts: Pick<CommitOptions, 'override'>) {
    const added = ports.browser.setImportMapFn(importMap, opts);
    config.log.debug(5, 'Added import map to browser.', importMap);
    // Wrapped: a promise returned bare from a .then would make the commit wait for it.
    return { added };
  }

  // Not awaited by the commit: a slow setter, such as the node loader's acknowledgement, must not hold up init.
  // A rejection is logged, then left unhandled as before, so trackers watching for those still see it.
  function preloadOnceAdded({ added }: { added: Promise<unknown> }, importMap: ImportMap) {
    Promise.resolve(added).then(
      () => preload(() => collectEagerPreloads(importMap)),
      error => {
        config.log.error(5, 'Could not add the import map.', error);
        return Promise.reject(error);
      }
    );
  }

  // A runtime load decides no serving build, so the next init decides one in each non-strict scope it wrote.
  function markUndecidedScopes() {
    const repo = ports.sharedExternalsRepo;
    for (const shareScope of repo.uncommittedScopes())
      if (repo.scopeType(shareScope) !== 'strict') repo.markUndecided(shareScope);
  }

  function persistRepositoryChanges() {
    ports.remoteInfoRepo.commit();
    ports.scopedExternalsRepo.commit();
    ports.sharedExternalsRepo.commit();
    ports.sharedChunksRepo.commit();
    return;
  }
}
