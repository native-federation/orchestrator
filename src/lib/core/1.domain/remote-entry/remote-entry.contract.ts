import type { SharedVersionAction } from '../externals/version.contract';
import type { RemoteEntryUrl } from './manifest.contract';
import type {
  DenseSharedInfo,
  ExposesInfo,
  FederationInfo,
  SharedInfo,
} from '@softarc/native-federation/domain';

type RawRemoteEntry = FederationInfo;

type RemoteEntry = Omit<FederationInfo, 'shared'> & {
  shared: DenseSharedInfo[];
  url: RemoteEntryUrl;
  host?: boolean;
  override?: boolean;
};

type SharedInfoActions = Record<
  string,
  {
    action: SharedVersionAction;
    // Where a shareScope skip's entrypoints are remapped to.
    override?: Record<string, string>;
    // Entrypoints the shared source provides; the rest are self-filled.
    covered?: string[];
  }
>;

export {
  RawRemoteEntry,
  RemoteEntry,
  FederationInfo,
  ExposesInfo,
  SharedInfo,
  DenseSharedInfo,
  SharedInfoActions,
};
