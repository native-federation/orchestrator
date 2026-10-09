import type { RemoteName } from 'lib/core/1.domain';
import type { PoolMember } from './membership';

// Basis precedence puts the host's own copy first on a `host: true` version, so its `remotes[0]` is the host.
export function hostRemotes(members: PoolMember[]): Set<RemoteName> {
  const hosts = new Set<RemoteName>();

  for (const member of members) {
    for (const version of member.external.versions) {
      if (version.host && version.remotes.length > 0) hosts.add(version.remotes[0]!.name);
    }
  }

  return hosts;
}

// The arrival order round 1 breaks ties by.
export function arrivalOrder(members: PoolMember[]): Map<RemoteName, number> {
  const arrival = new Map<RemoteName, number>();

  for (const member of members) {
    for (const version of member.external.versions) {
      for (const meta of version.remotes) {
        if (!arrival.has(meta.name)) arrival.set(meta.name, arrival.size);
      }
    }
  }

  return arrival;
}
