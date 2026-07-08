import type { ExternalName, RemoteName, SharedExternal, VersionName } from 'lib/core/1.domain';

export type PoolName = string;

export type PoolMember = {
  name: ExternalName;
  external: SharedExternal;
};

/**
 * The remote chosen to serve a whole pool, plus the version tag it provides for each member.
 * The anchor may be partial: members absent from `tagPerMember` are orphans (no coherent shared
 * build exists) and resolve scoped-only.
 */
export type PoolAnchor = {
  anchorRemote: RemoteName;
  tagPerMember: Partial<Record<ExternalName, VersionName>>;
};

/**
 * How a remote is placed relative to the anchor, decided once for the whole pool:
 *  - `follow`         — every member it uses is compatible with the anchor tag;
 *  - `scope-incompat` — strict-incompatible on ≥1 member; the whole family scopes with no dedup
 *                       (deduping would inject a foreign build via a shared intermediary).
 *                       Dominates `scope-coverage`;
 *  - `scope-coverage` — compatible where the anchor covers, but uses ≥1 member it does not provide;
 *                       scoped for coverage, may still dedup same-version members.
 */
export type RemoteClassification = 'follow' | 'scope-incompat' | 'scope-coverage';
