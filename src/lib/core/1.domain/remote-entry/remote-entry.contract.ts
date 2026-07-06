import type { SharedVersionAction } from '../externals/version.contract';
import type { RemoteEntryUrl } from './manifest.contract';
import type {
  ExposesInfo,
  FederationInfo,
  SharedInfo as BaseSharedInfo,
} from '@softarc/native-federation/domain';

// Widen upstream `SharedInfo` with an optional, additive `pool` tag: a remote may
// self-declare pool membership (mirrors the existing `shareScope?`). Upstream JSON
// without `pool` still parses unchanged.
type SharedInfo = BaseSharedInfo & { pool?: string };

type RemoteEntry = Omit<FederationInfo, 'shared'> & {
  shared: SharedInfo[];
  url: RemoteEntryUrl;
  host?: boolean;
  override?: boolean;
};

type SharedInfoActions = Record<string, { action: SharedVersionAction; override?: string }>;

export { RemoteEntry, FederationInfo, ExposesInfo, SharedInfo, SharedInfoActions };
