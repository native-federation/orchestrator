import type { SharedVersionAction } from '../externals/version.contract';
import type { RemoteEntryUrl } from './manifest.contract';
import type {
  DenseSharedInfo,
  ExposesInfo,
  FederationInfo,
  SharedInfo,
} from '@softarc/native-federation/domain';

type RawRemoteEntry = FederationInfo;

// `dense`: the remoteEntry published the entry dense, so its packageName is the build's own grouping. A flat
// entry is wrapped into the same shape, keyed by its specifier.
type RemoteSharedInfo = DenseSharedInfo & { dense?: true };

type RemoteEntry = Omit<FederationInfo, 'shared'> & {
  shared: RemoteSharedInfo[];
  url: RemoteEntryUrl;
  host?: boolean;
  override?: boolean;
};

type SharedInfoActions = Record<
  string,
  {
    action: SharedVersionAction;
    override?: Record<string, string>;
  }
>;

export {
  RawRemoteEntry,
  RemoteEntry,
  FederationInfo,
  ExposesInfo,
  SharedInfo,
  DenseSharedInfo,
  RemoteSharedInfo,
  SharedInfoActions,
};
