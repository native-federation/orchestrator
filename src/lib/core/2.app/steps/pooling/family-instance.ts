import type { ExternalName, RemoteName } from 'lib/core/1.domain';
import type { IsCompatible } from '../apply-winner';
import type {
  AcceptanceTable,
  ChosenTags,
  FamilyInstance,
  FamilyInstances,
  PoolMember,
} from './pool.types';

// Per remote, every member it ships and the tag it ships it at. An islanded remote offers nothing at
// all — not even members it solely provides, or the shared set itself stays incoherent (§15.3).
export function buildInstances(
  members: PoolMember[],
  islanded?: ReadonlySet<RemoteName>
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
 * Which offered tags each remote accepts per member. `strictVersion: false` accepts every tag: the
 * remote declared it would rather dedup than hold its own copy, and `determine` reads the flag the
 * same way, so testing the range alone would island remotes that dedup today (§15.1 rule 4).
 *
 * Mandatory precomputation, not an optimisation: election and the per-remote rounds ask acceptance
 * 510k times at R=50/M=80 against 3-14 distinct questions — 262 ms without the table, 4.4 ms with it.
 */
export function buildAcceptanceTable(
  instances: FamilyInstances,
  members: PoolMember[],
  isCompatible: IsCompatible
): AcceptanceTable {
  // Only a tag some instance actually ships can ever be chosen, so nothing else is worth asking.
  const offered = new Map<ExternalName, Set<string>>();
  for (const instance of instances.values()) {
    for (const [member, tag] of instance) {
      const tags = offered.get(member);
      if (tags) tags.add(tag);
      else offered.set(member, new Set([tag]));
    }
  }

  const table: AcceptanceTable = new Map();

  for (const member of members) {
    const tags = offered.get(member.name);
    if (!tags) continue; // no instance provides it: nothing to accept

    const versions = member.external.versions;
    for (let v = 0; v < versions.length; v++) {
      const remotes = versions[v]!.remotes;
      for (let r = 0; r < remotes.length; r++) {
        const meta = remotes[r]!;

        let byMember = table.get(meta.name);
        if (!byMember) table.set(meta.name, (byMember = new Map()));

        let accepted = byMember.get(member.name);
        if (!accepted) byMember.set(member.name, (accepted = new Set()));

        for (const tag of tags) {
          if (accepted.has(tag)) continue;
          if (!meta.strictVersion || isCompatible(tag, meta.requiredVersion)) accepted.add(tag);
        }
      }
    }
  }

  return table;
}

// Members exactly one instance ships, mapped to it. No decision to make, so they are assigned
// directly and never scored — otherwise the extension loop re-scores every instance every round.
export function singleProviderMembers(instances: FamilyInstances): Map<ExternalName, RemoteName> {
  const sole = new Map<ExternalName, RemoteName>();
  const contested = new Set<ExternalName>();

  for (const [remote, instance] of instances) {
    for (const member of instance.keys()) {
      if (contested.has(member)) continue;
      if (sole.has(member)) {
        sole.delete(member);
        contested.add(member);
      } else {
        sole.set(member, remote);
      }
    }
  }

  return sole;
}

// All-skip-or-all-scope: can this remote take every member it consumes from the chosen instances? A
// member nobody serves fails too — it would have to self-serve that one beside the chosen instances.
export function canTakeAllFrom(
  acceptance: AcceptanceTable,
  chosen: ChosenTags,
  remote: RemoteName,
  consumed: readonly ExternalName[]
): boolean {
  const byMember = acceptance.get(remote);

  for (let i = 0; i < consumed.length; i++) {
    const member = consumed[i]!;
    const tag = chosen.get(member);
    if (tag === undefined) return false;
    if (!byMember?.get(member)?.has(tag)) return false;
  }

  return true;
}

// Members the host declared, at its tag. Host precedence outranks pooling, so these are seeded
// before election and never re-pointed by it.
export function hostPinnedTags(members: PoolMember[]): ChosenTags {
  const pinned: ChosenTags = new Map();

  for (const member of members) {
    const versions = member.external.versions;
    for (let v = 0; v < versions.length; v++) {
      const version = versions[v]!;
      if (!version.host || version.action === 'scope') continue;
      pinned.set(member.name, version.tag);
      break;
    }
  }

  return pinned;
}
