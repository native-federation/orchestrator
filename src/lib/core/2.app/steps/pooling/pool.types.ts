import type { ExternalName, SharedExternal } from 'lib/core/1.domain';

export type PoolName = string;

export type PoolMember = {
  name: ExternalName;
  external: SharedExternal;
};
