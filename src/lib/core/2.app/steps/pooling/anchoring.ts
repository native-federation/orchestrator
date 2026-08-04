import type { ExternalName, RemoteName, VersionName } from 'lib/core/1.domain';
import type { BuildView, Coverage, FamilyInstance, PoolMember, Specifier } from './pool.types';

/**
 * The gates that choose which build serves a consumer. Everything here reads **coverage** and
 * `isCompatible`; no function in this file compares two tags for distance, only for identity. The
 * projections they read are in `pool-views.ts`, the rationale in docs/version-resolver.md §"The
 * provenance promise".
 */

/** `remote -> member -> every tag that remote's own `requiredVersion` accepts.` */
export type Acceptance = Map<RemoteName, Map<ExternalName, Set<VersionName>>>;

/** The build serving each remote, or `undefined` where it serves its own family. */
export type Assignment = Map<RemoteName, RemoteName | undefined>;

/**
 * Every tag each remote's own range accepts, per member. Precomputed rather than asked per
 * consumer/candidate pair, and `isCompatible` is expected to be `determine`'s memoized one — this must
 * never replicate its O(versions²) search.
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

/** Does a build serve a superset of what a consumer imports? */
export function covers(coverage: Coverage, consumed: Iterable<Specifier>): boolean {
  for (const specifier of consumed) if (!coverage.has(specifier)) return false;
  return true;
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

/**
 * Is the combination the global mapping would hand this remote one that some live build shipped?
 *
 * All-or-nothing across the family: **every** specifier it imports has to be published at the tag that one
 * single build ships it at. Taken per specifier instead it reintroduces the defect, a combination nothing
 * compiled. Why the general form is sound and not just the remote's-own-build case: §"Why the witness is
 * sound".
 *
 * Asked before coverage on both paths, because a witnessed remote needs no anchor at all: asking coverage
 * first pins remotes already sitting at the shared tags onto one build for no gain.
 */
export function isWitnessed(
  specifiers: Iterable<Specifier>,
  shared: Map<Specifier, VersionName>,
  builds: Map<RemoteName, BuildView>
): boolean {
  const wanted = [...specifiers];
  for (const specifier of wanted) if (!shared.has(specifier)) return false;

  for (const [, build] of builds) {
    let matches = true;
    for (let i = 0; i < wanted.length; i++) {
      if (build.tags.get(wanted[i]!) !== shared.get(wanted[i]!)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

export type SelfServeReason = { gap: string; closest?: RemoteName };

/**
 * Why no build could serve this remote, in the terms a portfolio owner can act on. Runs only for a remote
 * that is actually self-serving, so it costs nothing on a healthy portfolio.
 *
 * "Closest" is fewest missing entrypoints; a build that misses none failed on versions instead, and the gap
 * is then the member whose offered tag this remote's own range rejects.
 */
export function explainSelfServe(
  remote: RemoteName,
  wants: readonly ExternalName[],
  specifiers: Set<Specifier>,
  pool: { builds: Map<RemoteName, BuildView>; acceptance: Acceptance }
): SelfServeReason {
  let closest: RemoteName | undefined;
  let fewest = Number.MAX_SAFE_INTEGER;
  let gap: string = wants[0] ?? '';

  for (const [build, view] of pool.builds) {
    if (build === remote) continue;

    let missing: string | undefined;
    let count = 0;
    for (const specifier of specifiers) {
      if (view.coverage.has(specifier)) continue;
      count++;
      missing ??= specifier;
    }
    if (count >= fewest) continue;

    fewest = count;
    closest = build;
    gap = missing ?? rejectedMember(view.instance, remote, wants, pool.acceptance) ?? gap;
  }

  return { gap, closest };
}

// The first member a covering build offers at a tag the consumer's own range rejects — the other way a
// build fails the gate once coverage is satisfied.
function rejectedMember(
  offered: FamilyInstance,
  consumer: RemoteName,
  wants: readonly ExternalName[],
  acceptance: Acceptance
): string | undefined {
  const accepts = acceptance.get(consumer);
  if (!accepts) return undefined;

  for (const member of wants) {
    const tag = offered.get(member);
    if (tag === undefined) return member;
    if (!accepts.get(member)?.has(tag)) return `${member}@${tag}`;
  }
  return undefined;
}

export type AnchorInput = {
  builds: Map<RemoteName, BuildView>;
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
 * Greedy and deterministic, never a search. Tiebreaks in order: host, then most consumers fully covered,
 * then arrival, then name. A build chosen as an anchor **runs its own build**, so it is never itself
 * assigned elsewhere — a consumer deduping onto a remote that is itself deduping would inherit that
 * remote's foreign copies.
 */
export function assignAnchors(input: AnchorInput): Assignment {
  const { builds, acceptance, consumedMembers, hosts, arrival } = input;
  const assignment: Assignment = new Map();

  const byPriority = (a: RemoteName, b: RemoteName): number =>
    (arrival.get(a) ?? Number.MAX_SAFE_INTEGER) - (arrival.get(b) ?? Number.MAX_SAFE_INTEGER) ||
    a.localeCompare(b);

  const candidates = [...builds.keys()].sort(byPriority);
  const pending = new Set([...consumedMembers.keys()].sort(byPriority));
  const anchored = new Set<RemoteName>();

  const canServe = (candidate: RemoteName, consumer: RemoteName): boolean => {
    const build = builds.get(candidate)!;
    if (!covers(build.coverage, input.consumedSpecifiers.get(consumer) ?? [])) return false;
    return acceptsAll(acceptance, build.instance, consumer, consumedMembers.get(consumer) ?? []);
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

  // The host first: its build is already in the browser, so anything it can serve is served for free. It
  // leaves `pending` either way — it is never reassigned (constraint 5), so a host that is not a candidate
  // at all must still self-serve rather than fall through to the greedy pass and be anchored onto somebody
  // else.
  for (const host of [...hosts].sort(byPriority)) {
    const served = builds.has(host)
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
