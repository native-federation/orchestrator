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
export type PoolCause = 'incompatible' | 'uncovered' | 'torn' | 'unshared';

export type SharedVersionMeta = {
  requiredVersion: string;
  strictVersion: boolean;
  cached: boolean;
  name: RemoteName;
  bundle?: string;
  // The `pool` tag this remote declared, as it declared it. Pooling's input, never rewritten.
  pool?: string;
  entries: Record<string, string>;
  // The build serving this remote its copy, when pooling assigned it one other than the version's own
  // basis. Lives here rather than on `SharedVersion` because two consumers of the *same tag* can
  // legitimately take different anchors. Absent means the version's own basis.
  servedBy?: RemoteName;
  poolCause?: PoolCause;
};
