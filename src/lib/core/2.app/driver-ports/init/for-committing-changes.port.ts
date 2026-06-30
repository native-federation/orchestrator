import type { ImportMap } from 'lib/core/1.domain/import-map/import-map.contract';

export type CommitOptions = {
  /** Replace the cached map instead of merging into it (initial init installs the full map). */
  override?: boolean;
};

export type ForCommittingChanges = (
  importMap: ImportMap,
  opts?: CommitOptions
) => Promise<void>;
