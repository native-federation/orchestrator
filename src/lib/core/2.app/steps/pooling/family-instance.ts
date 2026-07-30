import type { ExternalName, RemoteName } from 'lib/core/1.domain';
import type { IsCompatible } from '../apply-winner';
import type {
  AcceptanceTable,
  ChosenTags,
  FamilyInstance,
  FamilyInstances,
  PoolMember,
} from './pool.types';

/**
 * The family instances a pool can be served from: per remote, every member it ships and the tag it
 * ships it at.
 *
 * Two exclusions, both load-bearing:
 * - **`scope` versions never count.** Promoting one cascades scoping and is self-defeating; a
 *   `scope` verdict is determine's, and pooling does not overrule it.
 * - **An islanded remote offers nothing at all**, not even the members it is the *sole* provider of.
 *   That is exactly the production capture's failure: the Angular-21 remote is correctly islanded on
 *   `core`, yet stays the only provider of `animations`, so `animations@21.2.18` would remain shared
 *   beside `core@22.0.8`. Islanding governs whose copies get deduped; only dropping the whole
 *   instance keeps the shared set itself coherent.
 */
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
        // A remote ships one copy per member; first tag wins so the result stays deterministic
        // even if storage ever holds two.
        if (!instance.has(member.name)) instance.set(member.name, version.tag);
      }
    }
  }

  return instances;
}

/**
 * Per remote, the members it consumes — what it must be served, whether or not that copy survived as
 * a shareable version. Wider than its instance: a remote whose copy of a member was marked `scope`
 * still needs that member at runtime.
 */
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
 * For every remote and member, which of the offered tags its declared `requiredVersion` accepts.
 *
 * **Mandatory precomputation, not an optimisation.** Acceptance is asked once per (remote, member,
 * candidate instance) during election and again per round of the per-remote pass; measured at
 * R=50/M=80 that is 510k calls against 3-14 distinct `(tag|range)` questions — 262 ms without the
 * table, 4.4 ms with it. Pass in the resolver's memoized `isCompatible` so those few questions are
 * answered once per init.
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
          if (!accepted.has(tag) && isCompatible(tag, meta.requiredVersion)) accepted.add(tag);
        }
      }
    }
  }

  return table;
}

/**
 * Members exactly one instance ships, mapped to that instance. They carry no decision, so they are
 * assigned directly and never scored — without this the extension loop re-scores every instance
 * every round (O(rounds · R² · M), and the difference between 4.4 ms and 262 ms at R=50/M=80).
 */
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

/**
 * The acceptance test behind all-skip-or-all-scope: can this remote take *every* member it consumes
 * from the chosen instances? A member nobody serves fails the test as well — the remote would have to
 * self-serve it beside the chosen instances, which is the mixed family this whole feature exists to
 * prevent.
 */
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

/**
 * Members the host declared, at the host's tag. Host precedence is priority #1 — above pooling — so
 * these are seeded *before* election and are never re-pointed by it. Using the host `remoteEntry.json`
 * to lock a version is a deliberate act; see docs/version-resolver.md.
 */
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
