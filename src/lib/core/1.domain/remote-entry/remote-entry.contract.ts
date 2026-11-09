import type { SharedVersionAction } from '../externals/version.contract';
import type { RemoteEntryUrl } from './manifest.contract';
import type {
  DenseSharedInfo as CoreDenseSharedInfo,
  ExposesInfo as CoreExposesInfo,
  FederationInfo as CoreFederationInfo,
  SharedInfo as CoreSharedInfo,
} from '@softarc/native-federation/domain';

// The preload fields core publishes from the release after 4.9; drop these once the devDependency has them.
type ChunkList = { chunks?: string[] };
type ExposesInfo = CoreExposesInfo & ChunkList;
type SharedInfo = CoreSharedInfo & ChunkList & { preload?: true };
type DenseSharedInfo = CoreDenseSharedInfo & ChunkList & { preload?: true };
type FederationInfo = Omit<CoreFederationInfo, 'exposes' | 'shared'> & {
  exposes: ExposesInfo[];
  shared: Array<SharedInfo | DenseSharedInfo>;
};

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
