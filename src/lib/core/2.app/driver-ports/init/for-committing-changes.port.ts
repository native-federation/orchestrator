import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';

export type CommitOptions = {
  /** Replace the DOM importmap instead of appending a partial one to it. */
  override?: boolean;
  // Marks every share scope written since the last commit as undecided. At commit, so it covers every step a runtime
  // load runs, with strictExternalCompatibility on too, and a new step needs no change.
  markUndecided?: boolean;
};

export type ForCommittingChanges = (importMap: ImportMap, opts?: CommitOptions) => Promise<void>;
