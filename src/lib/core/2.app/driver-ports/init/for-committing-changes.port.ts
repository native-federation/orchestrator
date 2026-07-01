import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';

export type CommitOptions = {
  /** Replace the DOM importmap instead of appending a partial one to it. */
  override?: boolean;
};

export type ForCommittingChanges = (importMap: ImportMap, opts?: CommitOptions) => Promise<void>;
