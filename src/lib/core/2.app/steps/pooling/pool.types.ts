import type { ExternalName, RemoteName, SharedExternal, VersionName } from 'lib/core/1.domain';

export type PoolName = string;

export type PoolMember = {
  name: ExternalName;
  external: SharedExternal;
};

/**
 * One remote's whole build of a pool: every member it ships and the tag it ships it at. This is the
 * unit of decision — a build is internally consistent *by construction*, which is what pooling needs
 * and what per-member tag comparison can never establish. See docs/version-resolver.md.
 */
export type FamilyInstance = Map<ExternalName, VersionName>;

export type FamilyInstances = Map<RemoteName, FamilyInstance>;

/** remote -> member -> the offered tags this remote's declared `requiredVersion` accepts. */
export type AcceptanceTable = Map<RemoteName, Map<ExternalName, Set<VersionName>>>;

/** member -> the tag the pool serves it at. Empty for members no chosen instance provides. */
export type ChosenTags = Map<ExternalName, VersionName>;
