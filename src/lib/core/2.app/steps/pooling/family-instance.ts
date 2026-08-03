import type { ExternalName, RemoteName } from 'lib/core/1.domain';
import type { FamilyInstance, FamilyInstances, PoolMember } from './pool.types';

// Per remote, every member it ships and the tag it ships it at. An islanded remote offers nothing at
// all — not even members it solely provides, or the shared set itself stays incoherent.
export function buildInstances(
  members: PoolMember[],
  // A Set or the step's Map of islanded remotes with their cause.
  islanded?: { has: (remote: RemoteName) => boolean }
): FamilyInstances {
  const instances: FamilyInstances = new Map();

  for (const member of members) {
    const versions = member.external.versions;
    for (let v = 0; v < versions.length; v++) {
      const version = versions[v]!;
      if (version.action === 'scope') continue;

      const remotes = version.remotes;
      for (let r = 0; r < remotes.length; r++) {
        const name = remotes[r]!.name;
        if (islanded?.has(name)) continue;

        let instance = instances.get(name);
        if (!instance) instances.set(name, (instance = new Map() as FamilyInstance));
        // A remote ships one copy per member; first tag wins to stay deterministic regardless.
        if (!instance.has(member.name)) instance.set(member.name, version.tag);
      }
    }
  }

  return instances;
}

// Per remote, what it must be served. Wider than its instance: a copy marked `scope` is excluded
// there but still consumed.
export function consumedMembers(members: PoolMember[]): Map<RemoteName, ExternalName[]> {
  const consumed = new Map<RemoteName, ExternalName[]>();

  for (const member of members) {
    const versions = member.external.versions;
    for (let v = 0; v < versions.length; v++) {
      const remotes = versions[v]!.remotes;
      for (let r = 0; r < remotes.length; r++) {
        const name = remotes[r]!.name;
        const list = consumed.get(name);
        if (!list) consumed.set(name, [member.name]);
        // Members are the outer loop, so a repeat can only be the entry just pushed.
        else if (list[list.length - 1] !== member.name) list.push(member.name);
      }
    }
  }

  return consumed;
}

/**
 * The build serving each member, i.e. `remotes[0]` of its shared version — skipping copies islanding
 * has taken, since those are about to self-serve. A member with no entry is served by nobody and every
 * consumer falls back to its own build.
 */
export function servingBuilds(
  members: PoolMember[],
  islanded: { has: (remote: RemoteName) => boolean }
): Map<ExternalName, RemoteName> {
  const serving = new Map<ExternalName, RemoteName>();

  for (const member of members) {
    const shared = member.external.versions.find(v => v.action === 'share');
    const basis = shared?.remotes.find(r => !islanded.has(r.name));
    if (basis) serving.set(member.name, basis.name);
  }

  return serving;
}
