import type { ExternalName, RemoteName, VersionName } from 'lib/core/1.domain';
import type { FamilyInstance, FamilyInstances, PoolMember } from './pool.types';

/**
 * Choosing which build serves a consumer, for the provenance promise — see
 * docs/version-resolver.md §"The provenance promise". Everything here reads **coverage** and
 * `isCompatible`; no function in this file compares two tags for distance, only for identity.
 *
 * Every set is keyed by entrypoint **specifier**, not by external name. A flat remote declares
 * `@framework/core/testing` as its own external while a dense one carries the same specifier as an
 * entry of `@framework/core`; comparing names makes those two shapes mutually uncoverable for a
 * build-tool reason with no provenance content.
 */

export type Specifier = string;

/** Every specifier a build serves, mapped to the file it serves it from. */
export type Coverage = Map<Specifier, string>;

/** `remote -> member -> every tag that remote's own `requiredVersion` accepts.` */
export type Acceptance = Map<RemoteName, Map<ExternalName, Set<VersionName>>>;

/** The build serving each remote, or `undefined` where it serves its own family. */
export type Assignment = Map<RemoteName, RemoteName | undefined>;

type Islanded = { has: (remote: RemoteName) => boolean };

/**
 * Coverage per candidate build, in one pass — Performance §4: built once per build and reused across
 * consumers, so a coverage question is a subset test rather than a walk of `entries`. Mirrors
 * `buildInstances`: a `scope` copy is about to self-serve, so it serves nobody else.
 */
export function coveragePerBuild(
  members: PoolMember[],
  islanded?: Islanded
): Map<RemoteName, Coverage> {
  const coverage = new Map<RemoteName, Coverage>();

  for (const member of members) {
    const versions = member.external.versions;
    for (let v = 0; v < versions.length; v++) {
      const version = versions[v]!;
      if (version.action === 'scope') continue;

      const remotes = version.remotes;
      for (let r = 0; r < remotes.length; r++) {
        const meta = remotes[r]!;
        if (islanded?.has(meta.name)) continue;

        let own = coverage.get(meta.name);
        if (!own) coverage.set(meta.name, (own = new Map()));
        for (const specifier in meta.entries) own.set(specifier, meta.entries[specifier]!);
      }
    }
  }

  return coverage;
}

/**
 * What each remote must be served, in specifier space. Wider than its coverage for the same reason
 * `consumedMembers` is wider than its instance: a copy marked `scope` is excluded from what a remote
 * can offer, but the remote still has to be able to import it.
 */
export function consumedSpecifiers(members: PoolMember[]): Map<RemoteName, Set<Specifier>> {
  const consumed = new Map<RemoteName, Set<Specifier>>();

  for (const member of members) {
    const versions = member.external.versions;
    for (let v = 0; v < versions.length; v++) {
      const remotes = versions[v]!.remotes;
      for (let r = 0; r < remotes.length; r++) {
        const meta = remotes[r]!;
        let own = consumed.get(meta.name);
        if (!own) consumed.set(meta.name, (own = new Set()));
        for (const specifier in meta.entries) own.add(specifier);
      }
    }
  }

  return consumed;
}

/** Does a build serve a superset of what a consumer imports? */
export function covers(coverage: Coverage, consumed: Iterable<Specifier>): boolean {
  for (const specifier of consumed) if (!coverage.has(specifier)) return false;
  return true;
}

/**
 * The acceptance table of Performance §3: every tag each remote's own range accepts, per member.
 * Precomputed rather than asked per consumer/candidate pair, and `isCompatible` is expected to be
 * `determine`'s memoized one — this must never replicate its O(versions²) search.
 */
export function acceptanceTable(
  members: PoolMember[],
  isCompatible: (tag: VersionName, range: string) => boolean
): Acceptance {
  const table: Acceptance = new Map();

  for (const member of members) {
    const tags: VersionName[] = [];
    for (const version of member.external.versions) tags.push(version.tag);

    for (const version of member.external.versions) {
      for (const meta of version.remotes) {
        let byMember = table.get(meta.name);
        if (!byMember) table.set(meta.name, (byMember = new Map()));
        if (byMember.has(member.name)) continue;

        const accepted = new Set<VersionName>();
        for (let t = 0; t < tags.length; t++) {
          if (isCompatible(tags[t]!, meta.requiredVersion)) accepted.add(tags[t]!);
        }
        byMember.set(member.name, accepted);
      }
    }
  }

  return table;
}

/** Does a build offer every member a consumer needs, at a tag the consumer's own range accepts? */
export function acceptsAll(
  acceptance: Acceptance,
  build: FamilyInstance,
  consumer: RemoteName,
  consumed: readonly ExternalName[]
): boolean {
  const byMember = acceptance.get(consumer);
  if (!byMember) return false;

  for (let i = 0; i < consumed.length; i++) {
    const offered = build.get(consumed[i]!);
    if (offered === undefined) return false;
    if (!byMember.get(consumed[i]!)?.has(offered)) return false;
  }

  return true;
}

/** Per build, the tag each specifier it serves is served at. */
export function tagsPerBuild(
  members: PoolMember[],
  islanded?: Islanded
): Map<RemoteName, Map<Specifier, VersionName>> {
  const tags = new Map<RemoteName, Map<Specifier, VersionName>>();

  for (const member of members) {
    const versions = member.external.versions;
    for (let v = 0; v < versions.length; v++) {
      const version = versions[v]!;
      if (version.action === 'scope') continue;

      const remotes = version.remotes;
      for (let r = 0; r < remotes.length; r++) {
        const meta = remotes[r]!;
        if (islanded?.has(meta.name)) continue;

        let own = tags.get(meta.name);
        if (!own) tags.set(meta.name, (own = new Map()));
        for (const specifier in meta.entries) {
          if (!own.has(specifier)) own.set(specifier, version.tag);
        }
      }
    }
  }

  return tags;
}

/**
 * The tag the shared set publishes per specifier: each member's `share` version, over the specifiers
 * its serving basis provides. What a consumer would land on through the global `imports`.
 */
export function sharedTagPerSpecifier(
  members: PoolMember[],
  islanded: Islanded
): Map<Specifier, VersionName> {
  const shared = new Map<Specifier, VersionName>();

  for (const member of members) {
    const winner = member.external.versions.find(v => v.action === 'share');
    const basis = winner?.remotes.find(r => !islanded.has(r.name));
    if (!basis) continue;
    for (const specifier in basis.entries) shared.set(specifier, winner!.tag);
  }

  return shared;
}

/**
 * The same-tag witness: specifiers a consumer may take from the shared set with **no** coverage test,
 * because they are offered at exactly the tag the consumer ships itself. Its own build compiled that
 * version beside the rest of its family, so its own build is the witness — the criterion is "one build,
 * *or* every member at the remote's own declared tag". Identity only; no tag distance is read.
 *
 * Callers must not apply this to the host, which is never reassigned (constraint 5) — measured, an
 * unexempted witness rewrites the host's own copy to another remote's build of the same tag.
 */
export function witnessedSpecifiers(
  own: Map<Specifier, VersionName>,
  shared: Map<Specifier, VersionName>
): Set<Specifier> {
  const witnessed = new Set<Specifier>();
  for (const [specifier, tag] of own) if (shared.get(specifier) === tag) witnessed.add(specifier);
  return witnessed;
}

/**
 * The host, when it ships anything in this pool. A host-contributed version carries `host: true` and
 * basis precedence puts the host's own copy first on it, so `remotes[0]` of such a version is the host.
 */
export function hostRemotes(members: PoolMember[]): Set<RemoteName> {
  const hosts = new Set<RemoteName>();

  for (const member of members) {
    for (const version of member.external.versions) {
      if (version.host && version.remotes.length > 0) hosts.add(version.remotes[0]!.name);
    }
  }

  return hosts;
}

/**
 * The tag `determine` elected per member, read before pooling rewrites the record. Retained so that a
 * provider disqualified as an *anchor* still supplies the global mapping, and so each copy has
 * something to be compared against — without it a member every provider loses leaves the shared set
 * for everyone, including the remotes already at its version.
 */
export function electedTags(members: PoolMember[]): Map<ExternalName, VersionName> {
  const elected = new Map<ExternalName, VersionName>();

  for (const member of members) {
    const winner = member.external.versions.find(v => v.action === 'share');
    if (winner) elected.set(member.name, winner.tag);
  }

  return elected;
}

/** First appearance of each remote across the pool — the arrival order anchor tiebreaks read. */
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

export type AnchorInput = {
  instances: FamilyInstances;
  coverage: Map<RemoteName, Coverage>;
  acceptance: Acceptance;
  consumedSpecifiers: Map<RemoteName, Set<Specifier>>;
  consumedMembers: Map<RemoteName, ExternalName[]>;
  hosts: Set<RemoteName>;
  arrival: Map<RemoteName, number>;
};

/**
 * Assign each consumer the build that serves it, or `undefined` where it serves its own family.
 *
 * Multi-anchor is mandatory rather than an optimisation (constraint 3): a single anchor per pool scopes
 * members nothing required to be scoped, and two remotes sharing no member already satisfy the promise.
 *
 * Greedy and deterministic, never a search (Performance §5). Tiebreaks in order: host, then most
 * consumers fully covered, then arrival, then name. A build chosen as an anchor **runs its own build**,
 * so it is never itself assigned elsewhere — a consumer deduping onto a remote that is itself deduping
 * would inherit that remote's foreign copies.
 */
export function assignAnchors(input: AnchorInput): Assignment {
  const { instances, coverage, acceptance, consumedMembers, hosts, arrival } = input;
  const assignment: Assignment = new Map();

  const byPriority = (a: RemoteName, b: RemoteName): number =>
    (arrival.get(a) ?? Number.MAX_SAFE_INTEGER) - (arrival.get(b) ?? Number.MAX_SAFE_INTEGER) ||
    a.localeCompare(b);

  const candidates = [...coverage.keys()].sort(byPriority);
  const pending = new Set([...consumedMembers.keys()].sort(byPriority));
  const anchored = new Set<RemoteName>();

  const canServe = (candidate: RemoteName, consumer: RemoteName): boolean => {
    const build = instances.get(candidate);
    if (!build) return false;
    if (!covers(coverage.get(candidate)!, input.consumedSpecifiers.get(consumer) ?? []))
      return false;
    return acceptsAll(acceptance, build, consumer, consumedMembers.get(consumer) ?? []);
  };

  const electAnchor = (anchor: RemoteName, served: readonly RemoteName[]): void => {
    pending.delete(anchor);
    assignment.set(anchor, undefined);
    for (const consumer of served) {
      pending.delete(consumer);
      anchored.add(consumer);
      assignment.set(consumer, anchor);
    }
  };

  // The host first: its build is already in the browser, so anything it can serve is served for free.
  // It leaves `pending` either way — it is never reassigned (constraint 5), so a host that is not a
  // candidate at all must still self-serve rather than fall through to the greedy pass and be anchored
  // onto somebody else.
  for (const host of [...hosts].sort(byPriority)) {
    const served = coverage.has(host)
      ? [...pending].filter(consumer => consumer !== host && canServe(host, consumer))
      : [];
    electAnchor(host, served);
  }

  for (;;) {
    let best: RemoteName | undefined;
    let bestServed: RemoteName[] = [];

    for (const candidate of candidates) {
      if (anchored.has(candidate)) continue;
      const served = [...pending].filter(
        consumer => consumer !== candidate && canServe(candidate, consumer)
      );
      // Strictly greater, so a tie stays with the earlier candidate and the order above decides.
      if (served.length > bestServed.length) {
        best = candidate;
        bestServed = served;
      }
    }

    if (best === undefined) break;
    electAnchor(best, bestServed);
  }

  for (const consumer of pending) assignment.set(consumer, undefined);
  return assignment;
}
