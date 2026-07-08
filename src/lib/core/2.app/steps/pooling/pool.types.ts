import type { ExternalName, RemoteName, SharedExternal, VersionName } from 'lib/core/1.domain';

export type PoolName = string;

/** A shared external that participates in a pool, paired with its name. */
export type PoolMember = {
  name: ExternalName;
  external: SharedExternal;
};

/**
 * The remote chosen to serve a whole pool, plus the version tag it provides for each member.
 * The anchor may be **partial**: `tagPerMember` holds an entry only for the members this remote
 * actually provides. Members absent from the map are orphans — no coherent shared build exists,
 * so they resolve scoped-only.
 */
export type PoolAnchor = {
  anchorRemote: RemoteName;
  tagPerMember: Partial<Record<ExternalName, VersionName>>;
};

/**
 * How a remote is placed relative to the anchor, decided once for the whole pool:
 *  - `follow`         — every member the remote uses is compatible with the anchor tag;
 *  - `scope-incompat` — strict-incompatible with the anchor on ≥1 covered member; the whole
 *                       family must scope with no dedup (deduping would inject a foreign build
 *                       via a shared intermediary). Dominates `scope-coverage`;
 *  - `scope-coverage` — compatible everywhere the anchor covers, but uses ≥1 member the anchor
 *                       does not provide; scoped for coverage, may still dedup same-version members.
 */
export type RemoteClassification = 'follow' | 'scope-incompat' | 'scope-coverage';
