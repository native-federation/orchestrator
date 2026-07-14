import type { RemoteName } from 'lib/core/1.domain';
import type { PoolMember } from './pool.types';

export function remotesInPool(members: PoolMember[]): RemoteName[] {
  return [
    ...new Set(members.flatMap(m => m.external.versions.flatMap(v => v.remotes.map(r => r.name)))),
  ];
}
