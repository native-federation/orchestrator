import type { SharedVersionAction } from '../externals/version.contract';
import type { RemoteEntryUrl } from './manifest.contract';
import type {
  DenseSharedInfo as CoreDenseSharedInfo,
  ExposesInfo as CoreExposesInfo,
  FederationInfo as CoreFederationInfo,
  SharedInfo as CoreSharedInfo,
} from '@softarc/native-federation/domain';

// Core's preload fields from 4.10; drop these once the @softarc/native-federation peer range starts at 4.10.
// Keyed by the chunk's import name; `initial` marks the module's static closure, written only when true.
type ChunkMap = Record<string, { file: string; initial?: true }>;
type ExposesInfo = CoreExposesInfo & { chunks?: ChunkMap };
type SharedInfo = CoreSharedInfo & { preload?: true };
type DenseSharedInfo = CoreDenseSharedInfo & { preload?: true };
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
  ChunkMap,
  FederationInfo,
  ExposesInfo,
  SharedInfo,
  DenseSharedInfo,
  RemoteSharedInfo,
  SharedInfoActions,
};
