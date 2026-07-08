import type { SharedVersionAction } from '../externals/version.contract';
import type { RemoteEntryUrl } from './manifest.contract';
import type {
  ExposesInfo,
  FederationInfo,
  SharedInfo as BaseSharedInfo,
} from '@softarc/native-federation/domain';

// Todo: Remove when upstream includes pool prop
type SharedInfo = BaseSharedInfo & { pool?: string };

type RemoteEntry = Omit<FederationInfo, 'shared'> & {
  shared: SharedInfo[];
  url: RemoteEntryUrl;
  host?: boolean;
  override?: boolean;
};

type SharedInfoActions = Record<string, { action: SharedVersionAction; override?: string }>;

export { RemoteEntry, FederationInfo, ExposesInfo, SharedInfo, SharedInfoActions };
