import type { ExternalName, RemoteName, SharedExternal, VersionName } from 'lib/core/1.domain';

export type PoolName = string;

export type PoolMember = {
  name: ExternalName;
  external: SharedExternal;
};

// One remote's whole build of a pool: every member it ships and the tag it ships it at. The unit of
// decision, because a build is internally consistent by construction.
export type FamilyInstance = Map<ExternalName, VersionName>;

export type FamilyInstances = Map<RemoteName, FamilyInstance>;

/** remote -> member -> the offered tags that remote accepts. */
export type AcceptanceTable = Map<RemoteName, Map<ExternalName, Set<VersionName>>>;

/** member -> the tag the pool serves it at; absent when no chosen instance provides it. */
export type ChosenTags = Map<ExternalName, VersionName>;
