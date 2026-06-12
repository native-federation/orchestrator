import type { ForCommittingChanges } from './for-committing-changes.port';
import type { ForDeterminingSharedExternals } from './for-determining-shared-externals.port';
import type { ForExposingModuleLoader } from './for-exposing-module-loader.port';
import type { ForGeneratingImportMap } from './for-generating-import-map';
import type { ForGettingRemoteEntries } from './for-getting-remote-entries.port';
import type { ForProcessingRemoteEntries } from './for-processing-remote-entries.port';
import type { ForGettingRemoteEntry } from './for-getting-remote-entry.port';
import type { ForUpdatingCache } from './for-updating-cache';
import type { ForConvertingToImportMap } from './for-converting-to-import-map';
import type { ConfigContract } from 'lib/core/2.app/config';
import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';

export type InitDriversContract = {
  getRemoteEntries: ForGettingRemoteEntries;
  processRemoteEntries: ForProcessingRemoteEntries;
  determineSharedExternals: ForDeterminingSharedExternals;
  generateImportMap: ForGeneratingImportMap;
  commitChanges: ForCommittingChanges;
  exposeModuleLoader: ForExposingModuleLoader;
  getRemoteEntry: ForGettingRemoteEntry;
  updateCache: ForUpdatingCache;
  convertToImportMap: ForConvertingToImportMap;
};

export type InitDriversFactory = (
  config: ConfigContract,
  adapters: DrivingContract
) => InitDriversContract;
