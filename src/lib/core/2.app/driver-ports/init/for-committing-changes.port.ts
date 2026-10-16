import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';

export type CommitOptions = {
  /** Replace the DOM importmap instead of appending a partial one to it. */
  override?: boolean;
  /** Mark every share scope written since the last commit as undecided, for a runtime load. */
  markUndecided?: boolean;
};

export type ForCommittingChanges = (importMap: ImportMap, opts?: CommitOptions) => Promise<void>;
