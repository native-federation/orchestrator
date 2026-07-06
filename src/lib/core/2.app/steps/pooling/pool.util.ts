import type { RemoteName, SharedVersion } from 'lib/core/1.domain';
import type { PoolMember } from './pool.types';

/**
 * The single version a remote contributes for a member, if any. A remote declares at
 * most one version of a given external, so the first match is unambiguous.
 */
export function versionForRemote(
  member: PoolMember,
  remote: RemoteName
): SharedVersion | undefined {
  return member.external.versions.find(v => v.remotes.some(r => r.name === remote));
}

/** Every distinct remote name that appears anywhere in the pool. */
export function remotesInPool(members: PoolMember[]): RemoteName[] {
  return [
    ...new Set(members.flatMap(m => m.external.versions.flatMap(v => v.remotes.map(r => r.name)))),
  ];
}
