import type { RemoteName } from '../remote/remote-info.contract';

export type VersionName = string;

export type Version = {
  tag: VersionName;
};

export type ScopedVersion = Version & {
  bundle?: string;
  entries: Record<string, string>;
};

export type SharedVersion = Version & {
  host: boolean;
  action: SharedVersionAction;
  remotes: SharedVersionMeta[];
};

export type SharedVersionAction = 'skip' | 'scope' | 'share';

// Why pooling made a copy serve itself. See docs/version-resolver.md §"What pooling stores".
export type PoolCause = 'incompatible' | 'uncovered';

export type SharedVersionMeta = {
  requiredVersion: string;
  strictVersion: boolean;
  cached: boolean;
  name: RemoteName;
  bundle?: string;
  // The `pool` label this remote declared, as it declared it. Pooling's input, never rewritten.
  pool?: string;
  entries: Record<string, string>;
  // The build of the subpool this copy runs in, when pooling placed it in one rather than on the version's
  // own basis. Lives here rather than on `SharedVersion` because two consumers of the *same tag* can
  // legitimately run in different subpools. Absent means the version's own basis.
  servedBy?: RemoteName;
  poolCause?: PoolCause;
};
