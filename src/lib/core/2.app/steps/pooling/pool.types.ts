import type { ExternalName, RemoteName, SharedExternal, VersionName } from 'lib/core/1.domain';

export type PoolName = string;

/** An entrypoint as a consumer imports it. Nothing is keyed by external name — see `pool-views.ts`. */
export type Specifier = string;

export type PoolMember = {
  name: ExternalName;
  external: SharedExternal;
};

// One remote's whole build of a pool: every member it ships and the tag it ships it at. The unit of
// decision, because a build is internally consistent by construction.
export type FamilyInstance = Map<ExternalName, VersionName>;

/** Every specifier a build serves, mapped to the file it serves it from. */
export type Coverage = Map<Specifier, string>;

/** One build, as every gate reads it. */
export type BuildView = {
  coverage: Coverage;
  tags: Map<Specifier, VersionName>;
  instance: FamilyInstance;
};

export type CommittedView = {
  builds: Map<RemoteName, BuildView>;
  /** Per specifier, what the committed `imports` serves and from where. */
  global: Map<Specifier, { tag: VersionName; remote: RemoteName; file: string }>;
};

// Structurally either a Set of remote names or the step's Map of islanded remotes with their cause.
export type Islanded = { has: (remote: RemoteName) => boolean };
