import type { SharedVersionAction } from '../externals/version.contract';
import type { RemoteEntryUrl } from './manifest.contract';
import type {
  ExposesInfo,
  FederationInfo,
  SharedInfo as BaseSharedInfo,
} from '@softarc/native-federation/domain';

// Todo: Remove when upstream includes entries prop. A shared external carries either a
// single `outFileName` or an `entries` map (packageName -> output file), never both.
type SharedInfoCommon = Omit<BaseSharedInfo, 'outFileName'>;
type SharedInfo =
  | (SharedInfoCommon & { outFileName: string; entries?: never })
  | (SharedInfoCommon & { outFileName?: never; entries: Record<string, string> });

type RemoteEntry = Omit<FederationInfo, 'shared'> & {
  shared: SharedInfo[];
  url: RemoteEntryUrl;
  host?: boolean;
  override?: boolean;
};

// Normalises the transitional union to an entrypoint map (packageName -> output file).
function sharedInfoEntries(shared: SharedInfo): Record<string, string> {
  if (shared.entries) return shared.entries;
  return { [shared.packageName]: shared.outFileName };
}

// override: entrypoint (packageName) -> absolute URL on the providing remote.
type SharedInfoActions = Record<
  string,
  { action: SharedVersionAction; override?: Record<string, string> }
>;

export {
  RemoteEntry,
  FederationInfo,
  ExposesInfo,
  SharedInfo,
  SharedInfoActions,
  sharedInfoEntries,
};
