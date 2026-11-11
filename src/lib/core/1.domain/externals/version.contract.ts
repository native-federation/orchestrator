import type { RemoteName } from '../remote/remote-info.contract';

export type VersionName = string;

export type Version = {
  tag: VersionName;
};

export type ScopedVersion = Version & {
  bundle?: string;
  entries: Record<string, string>;
  // see docs/config.md §Preloading
  preload?: true;
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
  // Pooling's input, as declared: never rewritten.
  pool?: string;
  // See `RemoteSharedInfo`.
  dense?: true;
  entries: Record<string, string>;
  // Per copy, not per version: two consumers of the same tag can run in different subpools.
  servedBy?: RemoteName;
  poolCause?: PoolCause;
  preload?: true;
  // see docs/version-resolver.md §"Preferring a dev build while debugging"
  dev?: true;
};
