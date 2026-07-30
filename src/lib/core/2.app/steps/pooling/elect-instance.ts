import type { ExternalName, RemoteName } from 'lib/core/1.domain';
import { canTakeAllFrom, hostPinnedTags, singleProviderMembers } from './family-instance';
import type {
  AcceptanceTable,
  ChosenTags,
  FamilyInstance,
  FamilyInstances,
  PoolMember,
} from './pool.types';

// The tag each member is shared at right now, as determine left it.
export function currentSharedTags(members: PoolMember[]): ChosenTags {
  const tags: ChosenTags = new Map();
  for (const member of members) {
    const shared = member.external.versions.find(v => v.action === 'share');
    if (shared) tags.set(member.name, shared.tag);
  }
  return tags;
}

// Already coherent when one instance offers every shared member at the tag it is shared at, so no
// consumer can draw two builds. The healthy-portfolio path: no scoring, no acceptance questions.
export function coveredBySingleInstance(instances: FamilyInstances, tags: ChosenTags): boolean {
  for (const instance of instances.values()) {
    let covers = true;
    for (const [member, tag] of tags) {
      if (instance.get(member) !== tag) {
        covers = false;
        break;
      }
    }
    if (covers) return true;
  }
  return false;
}

/**
 * How many remotes are already served entirely by one build. Election's objective is exactly this
 * count, so when it equals the number of instances there is nothing left to win and scoring is
 * skipped — one walk over the members, no compatibility question.
 */
export function remotesServedByOneBuild(
  instances: FamilyInstances,
  consumed: Map<RemoteName, ExternalName[]>,
  tags: ChosenTags
): number {
  // Per member, the instances that offer it at the tag it is actually served at.
  const providers = new Map<ExternalName, Set<RemoteName>>();
  for (const [remote, offer] of instances) {
    for (const [member, tag] of offer) {
      if (tags.get(member) !== tag) continue;
      const set = providers.get(member);
      if (set) set.add(remote);
      else providers.set(member, new Set([remote]));
    }
  }

  // A remote is served by one build exactly when some instance provides everything it consumes.
  let served = 0;
  for (const [remote, wants] of consumed) {
    if (!instances.has(remote)) continue; // islanded: it self-serves everything

    let common: Set<RemoteName> | undefined;
    let single = true;
    for (let i = 0; i < wants.length; i++) {
      // Unserved members are the per-remote pass's business, not election's.
      if (tags.get(wants[i]!) === undefined) continue;
      const offering = providers.get(wants[i]!);
      if (!offering) {
        single = false;
        break;
      }
      if (!common) common = new Set(offering);
      else for (const candidate of common) if (!offering.has(candidate)) common.delete(candidate);
      if (common.size === 0) {
        single = false;
        break;
      }
    }
    if (single) served++;
  }
  return served;
}

/**
 * The most remotes any single instance could possibly serve entirely — coverage only, so no
 * acceptance table and no compatibility question. `servesAlone` additionally demands acceptance and
 * whole packages, so this is an upper bound on election's objective: when it does not beat what the
 * current assignment already achieves, no election can, and scoring is skipped.
 *
 * This is what keeps ragged portfolios cheap. There, every remote is already served by its own build,
 * so the status quo scores near the maximum while no single instance covers many remotes outright.
 */
export function bestPossibleServed(
  instances: FamilyInstances,
  consumed: Map<RemoteName, ExternalName[]>
): number {
  let best = 0;
  for (const offer of instances.values()) {
    let covered = 0;
    for (const [remote, wants] of consumed) {
      if (!instances.has(remote)) continue;
      let all = true;
      for (let i = 0; i < wants.length; i++) {
        if (!offer.has(wants[i]!)) {
          all = false;
          break;
        }
      }
      if (all) covered++;
    }
    if (covered > best) best = covered;
  }
  return best;
}

// `@angular/core/primitives/di` -> `@angular/core`, `rxjs/operators` -> `rxjs`. Package boundaries are
// not in the remote entry, so this is the naming convention; it can only ever restrict election.
export function packageOf(name: ExternalName): string {
  const first = name.indexOf('/');
  if (first === -1) return name;
  if (!name.startsWith('@')) return name.slice(0, first);
  const second = name.indexOf('/', first + 1);
  return second === -1 ? name : name.slice(0, second);
}

/**
 * Members grouped by package, restricted to those some live instance ships. Entrypoints of one package
 * must be served from one build — election takes a package whole or not at all. Without this the
 * extension pass fills the siblings an elected instance does not ship from another instance, which on
 * `benchmark/` left `@angular/core@22.0.6` beside `@angular/core/primitives/signals@22.0.8`.
 */
export function packageGroups(
  members: PoolMember[],
  instances: FamilyInstances
): Map<string, ExternalName[]> {
  const live = new Set<ExternalName>();
  for (const instance of instances.values()) for (const member of instance.keys()) live.add(member);

  const groups = new Map<string, ExternalName[]>();
  for (const member of members) {
    if (!live.has(member.name)) continue;
    const pkg = packageOf(member.name);
    const group = groups.get(pkg);
    if (group) group.push(member.name);
    else groups.set(pkg, [member.name]);
  }
  return groups;
}

type Score = {
  remote: RemoteName;
  served: number;
  foreign: number;
  size: number;
  host: boolean;
  declarer: boolean;
};

// served desc, then the §15.1 tiebreaks: fewer foreign members -> instance size -> host ->
// declaring remote -> name.
function better(a: Score, b: Score | undefined): boolean {
  if (!b) return true;
  if (a.served !== b.served) return a.served > b.served;
  if (a.foreign !== b.foreign) return a.foreign < b.foreign;
  if (a.size !== b.size) return a.size > b.size;
  if (a.host !== b.host) return a.host;
  if (a.declarer !== b.declarer) return a.declarer;
  return a.remote.localeCompare(b.remote) < 0;
}

/**
 * Chooses which tag each member is served at, per research.md §15.1 rule 3: maximise the remotes that
 * can dedup *entirely* onto the chosen instances. Raw instance size is only a tiebreak — on the
 * production capture the biggest instance is the Angular-21 one, and electing it islands 6 of 7
 * remotes (46 downloads against 17).
 *
 * Host pins and single-provider members are seeded first and never scored: the host outranks pooling,
 * and a member one instance ships carries no decision.
 */
export function electInstances(
  members: PoolMember[],
  instances: FamilyInstances,
  acceptance: AcceptanceTable,
  consumed: Map<RemoteName, ExternalName[]>
): ChosenTags {
  const hostPinned = hostPinnedTags(members);
  const chosen: ChosenTags = new Map(hostPinned);
  for (const [member, remote] of singleProviderMembers(instances)) {
    if (!chosen.has(member)) chosen.set(member, instances.get(remote)!.get(member)!);
  }

  const hostRemotes = new Set<RemoteName>();
  const declarers = new Set<RemoteName>();
  for (const member of members) {
    for (const version of member.external.versions) {
      for (const meta of version.remotes) {
        if (version.host) hostRemotes.add(meta.name);
        if (meta.pool?.trim()) declarers.add(meta.name);
      }
    }
  }

  const groupList = [...packageGroups(members, instances).values()];
  const groupIdOf = new Map<ExternalName, number>();
  groupList.forEach((group, id) => group.forEach(member => groupIdOf.set(member, id)));

  // Which groups each instance may take, recomputed whenever `chosen` grows (a pin can rule a group
  // out). One pass over instances x groups instead of a walk per consumed member per candidate.
  const takeable = new Map<RemoteName, boolean[]>();
  const refreshTakeable = () => {
    for (const [remote, offer] of instances) {
      takeable.set(
        remote,
        groupList.map(group => takes(offer, group))
      );
    }
  };

  // A package is taken whole: the instance must ship every live member of it, at tags that agree with
  // anything already pinned (host precedence, single-provider).
  const takes = (offer: FamilyInstance, group: ExternalName[]): boolean => {
    for (let i = 0; i < group.length; i++) {
      const tag = offer.get(group[i]!);
      if (tag === undefined) return false;
      const already = chosen.get(group[i]!);
      if (already !== undefined && already !== tag) return false;
    }
    return true;
  };

  // Can this instance serve `remote` on its own? Every member it consumes has to be in the offer, at
  // a tag its range accepts and in a package the instance can take whole. Coverage is the whole point:
  // a remote served from one build is consistent by construction, which no tag comparison can
  // establish (§14.2). Counting "some acceptable mix of instances" instead would re-elect the very
  // split families this fixes.
  const servesAlone = (
    candidate: RemoteName,
    offer: FamilyInstance,
    remote: RemoteName
  ): boolean => {
    const allowed = takeable.get(candidate)!;
    const accepted = acceptance.get(remote);
    const wants = consumed.get(remote) ?? [];
    for (let i = 0; i < wants.length; i++) {
      const member = wants[i]!;
      const tag = offer.get(member);
      if (tag === undefined) return false;
      const pinned = chosen.get(member);
      if (pinned !== undefined && pinned !== tag && hostPinned.has(member)) return false;
      if (!accepted?.get(member)?.has(tag)) return false;
      const group = groupIdOf.get(member);
      if (group === undefined || !allowed[group]) return false;
    }
    return true;
  };

  // One scratch map for every trial assignment, refilled per candidate. Only whole packages, so the
  // score reflects what the commit below would actually assign.
  const trial: ChosenTags = new Map();
  const fill = (remote: RemoteName, offer: FamilyInstance) => {
    trial.clear();
    for (const [member, tag] of chosen) trial.set(member, tag);
    const allowed = takeable.get(remote)!;
    groupList.forEach((group, id) => {
      if (!allowed[id]) return;
      for (const member of group) if (!trial.has(member)) trial.set(member, offer.get(member)!);
    });
  };

  const score = (remote: RemoteName, offer: FamilyInstance, alone: boolean): Score => {
    let served = 0;
    if (alone) {
      for (const candidate of instances.keys()) if (servesAlone(remote, offer, candidate)) served++;
    } else {
      fill(remote, offer);
      for (const candidate of instances.keys()) {
        if (canTakeAllFrom(acceptance, trial, candidate, consumed.get(candidate) ?? [])) served++;
      }
    }

    // Members the shared set would draw from somewhere other than this instance. A proxy for
    // "fewer chosen instances" (§14.2): the exact count depends on the extension pass, and
    // computing it per candidate is what made the naive prototype 60x slower.
    fill(remote, offer);
    let foreign = 0;
    for (const [member, tag] of trial) if (offer.get(member) !== tag) foreign++;

    return {
      remote,
      served,
      foreign,
      size: offer.size,
      host: hostRemotes.has(remote),
      declarer: declarers.has(remote),
    };
  };

  refreshTakeable();

  let primary: Score | undefined;
  for (const [remote, offer] of instances) {
    const candidate = score(remote, offer, true);
    if (better(candidate, primary)) primary = candidate;
  }
  if (!primary) return chosen;

  const commit = (remote: RemoteName, offer: FamilyInstance) => {
    const allowed = takeable.get(remote)!;
    groupList.forEach((group, id) => {
      if (!allowed[id]) return;
      for (const member of group) if (!chosen.has(member)) chosen.set(member, offer.get(member)!);
    });
  };
  commit(primary.remote, instances.get(primary.remote)!);

  // Extension: members the primary does not ship, from whichever instance unlocks the most remotes.
  // Every round commits at least one member, so it terminates in at most one round per member.
  for (;;) {
    let unchosen = 0;
    for (const member of members) if (!chosen.has(member.name)) unchosen++;
    if (unchosen === 0) break;

    refreshTakeable();

    let best: Score | undefined;
    for (const [remote, offer] of instances) {
      // Only a candidate that can take a whole package containing an unchosen member moves the
      // assignment forward; without that check the loop could pick one that commits nothing.
      const allowed = takeable.get(remote)!;
      let offers = false;
      for (let id = 0; id < groupList.length; id++) {
        if (!allowed[id] || !groupList[id]!.some(member => !chosen.has(member))) continue;
        offers = true;
        break;
      }
      if (!offers) continue;

      // Extension scores the whole assignment, not the instance alone: the shared set may legally
      // span instances (F3), and what matters here is how many remotes the addition unlocks.
      const candidate = score(remote, offer, false);
      if (better(candidate, best)) best = candidate;
    }
    if (!best) break;

    commit(best.remote, instances.get(best.remote)!);
  }

  return chosen;
}
