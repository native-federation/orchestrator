import type { ExternalName, RemoteName, SharedExternal, VersionName } from 'lib/core/1.domain';

export type PoolName = string;

/** A shared external that participates in a pool, paired with its name. */
export type PoolMember = {
  name: ExternalName;
  external: SharedExternal;
};

/**
 * The remote chosen to serve a whole pool, plus the version tag it provides for each
 * member. The anchor is guaranteed to provide *every* member.
 */
export type PoolAnchor = {
  anchorRemote: RemoteName;
  tagPerMember: Record<ExternalName, VersionName>;
};

/** How a remote is placed relative to the anchor, decided once for the whole pool. */
export type RemoteClassification = 'follow' | 'scope';
