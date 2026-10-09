import type { ExternalName, RemoteName, VersionName } from 'lib/core/1.domain';
import type { AcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import {
  owningPackage,
  type Specifier,
  SpecifierTags,
} from 'lib/core/1.domain/externals/specifier';
import { type Build, buildOf, type Copy, copiesByRemote } from './builds';
import type { PoolMember } from './membership';
import { agrees, serves as servesAt, shippedTogether } from './rules';
import { compareStrings } from 'lib/utils/compare-strings';

// Who serves each remote of one pool, keyed by specifier; pure, `pool-shared-externals.ts` turns it into
// verdicts. See docs/version-resolver.md §"How pooling resolves".

export type ElectionInput = {
  members: PoolMember[];
  acceptsTag: AcceptsTag;
  hosts: ReadonlySet<RemoteName>;
  compare: (a: VersionName, b: VersionName) => number;
  // The round-1 winner the stored record carries from the last election, for the tie rule.
  previous?: RemoteName;
  latestFirst: boolean;
};

export type Election = {
  // Round 1's build; undefined only for a pool with no copies.
  winner?: RemoteName;
  // The winner's specifiers, same-tag loans from agreeing builds, and packages they all add at one tag.
  coverage: SpecifierTags;
  // Everyone the global map serves, the winner included.
  global: Set<RemoteName>;
  // Later rounds, in election order; `build` is one of `members`.
  subpools: { build: RemoteName; members: RemoteName[] }[];
  alone: RemoteName[];
  // Remotes outside round 1 that agree with the winner on everything both ship (rule 5).
  agreeing: Set<RemoteName>;
  // Those of `agreeing` that take every member they ship from the global map, so may publish its files.
  publishers: Set<RemoteName>;
  // A rejected tag (a strict range's first, as `strictExternalCompatibility` refuses that), else a gap,
  // else specifiers no one build shipped together. Undefined only for a subpool's build the global map
  // would serve.
  missOf: (
    remote: RemoteName
  ) =>
    | { rejected: { member: ExternalName; tag: VersionName; strict: boolean } }
    | { gap: Specifier }
    | { unwitnessed: { gap: Specifier; with: Specifier[] } }
    | undefined;
};

export function electVariants(input: ElectionInput): Election {
  const { members, acceptsTag, hosts, compare } = input;

  const shipped = copiesByRemote(members);
  const builds = new Map<RemoteName, Build>();
  for (const [owner, copies] of shipped) builds.set(owner, buildOf(owner, copies));
  const buildFor = (owner: RemoteName) => builds.get(owner)!;

  // Which build is newer: the first member both ship, in pool order, whose tags differ decides, so two
  // unrelated version lines are never compared.
  const newer = (a: Build, b: Build): number => {
    for (const { name } of members) {
      const tagA = a.tagByMember.get(name);
      const tagB = b.tagByMember.get(name);
      if (tagA === undefined || tagB === undefined) continue;
      const d = compare(tagA, tagB);
      if (d !== 0) return d;
    }
    return 0;
  };

  // Same tag, same artefact: round 1 also serves entrypoints other copies of its tags ship — but only from
  // builds that agree with it, since a borrowed file binds its own imports where it lives.
  const withSameTagEntries = (own: Build) => {
    const tags = new SpecifierTags(own.tags);
    const loans = new Map<Specifier, RemoteName[]>();
    for (const [remote, copies] of shipped) {
      if (remote === own.owner || !agrees(copies, own.tags)) continue;
      for (const copy of copies)
        for (const specifier of copy.specifiers)
          if (!own.tags.has(specifier) && own.tags.tagOf(specifier) === copy.tag) {
            tags.set(specifier, copy.tag);
            loans.set(specifier, [...(loans.get(specifier) ?? []), remote]);
          }
    }
    return { tags, loans };
  };

  const serves = (copies: readonly Copy[], tags: SpecifierTags) =>
    servesAt(copies, tags, acceptsTag);
  const witnessed = (remote: RemoteName) =>
    shippedTogether(shipped.get(remote)!, coverage, builds.values());
  // The first specifier no build ships next to the ones before it, and a smallest set of those it clashes with.
  const unwitnessed = (remote: RemoteName) => {
    const specifiers = shipped.get(remote)!.flatMap(c => c.specifiers);
    const matches = [...shipped.keys()].map(owner => {
      const { tags } = buildFor(owner);
      return specifiers.map(s => tags.tagOf(s) === coverage.get(s));
    });
    let alive = matches;
    let end = -1;
    for (let i = 0; i < specifiers.length && end === -1; i++) {
      alive = alive.filter(m => m[i]);
      if (alive.length === 0) end = i;
    }
    if (end === -1) return undefined;

    const together = (indices: number[]) => matches.some(m => indices.every(i => m[i]));
    let clash = Array.from({ length: end }, (_, i) => i);
    for (let i = 0; i < end; i++) {
      // By specifier, not index: two members may list the same one, and dropping it drops every repeat.
      const without = clash.filter(c => specifiers[c] !== specifiers[i]);
      if (!together([...without, end])) clash = without;
    }
    return { gap: specifiers[end]!, with: clash.map(i => specifiers[i]!) };
  };

  // In record order: the order remotes first appear in the pool's versions, which round 1's ties fall back to.
  const remotes = [...shipped.keys()];
  const recordOrder = new Map(remotes.map((r, i) => [r, i]));

  // Highest first on every key, then the newer build; the sort is stable, so the input order breaks the rest.
  const rank = <C extends { own: Build }>(candidates: C[], keys: ((c: C) => number)[]) => {
    const scored = candidates.map(c => ({ c, k: keys.map(key => key(c)) }));
    scored.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const d = b.k[i]! - a.k[i]!;
        if (d !== 0) return d;
      }
      return newer(b.c.own, a.c.own);
    });
    return scored[0]?.c;
  };

  const coverage = new SpecifierTags();
  const election: Election = {
    coverage,
    global: new Set(),
    subpools: [],
    alone: [],
    agreeing: new Set(),
    publishers: new Set(),
    missOf: remote => {
      let rejected: { member: ExternalName; tag: VersionName; strict: boolean } | undefined;
      for (const copy of shipped.get(remote) ?? [])
        for (const s of copy.specifiers) {
          const tag = coverage.get(s);
          if (tag === undefined || acceptsTag(tag, copy.tag, copy.requiredVersion)) continue;
          if (copy.strict) return { rejected: { member: copy.member, tag, strict: true } };
          rejected ??= { member: copy.member, tag, strict: false };
        }
      if (rejected) return { rejected };
      for (const copy of shipped.get(remote) ?? [])
        for (const s of copy.specifiers) if (!coverage.has(s)) return { gap: s };
      const torn = unwitnessed(remote);
      if (torn) return { unwitnessed: torn };
      // Everyone else the extended coverage serves is global, so only a subpool's build can lack a reason.
      if (election.subpools.some(p => p.build === remote)) return undefined;
      throw new Error(`'${remote}' missed the global map with nothing it rejects or lacks.`);
    },
  };
  if (remotes.length === 0) return election;

  // Round 1. The host cannot be repointed, so its build is the global one whenever it ships any member.
  const host = remotes.find(r => hosts.has(r));
  type Candidate = {
    own: Build;
    // The build's tags plus its loans.
    tags: SpecifierTags;
    loans: Map<Specifier, RemoteName[]>;
    served: RemoteName[];
  };
  const round1 = (host ? [host] : remotes).map<Candidate>(owner => {
    const own = buildFor(owner);
    const { tags, loans } = withSameTagEntries(own);
    return { own, tags, loans, served: remotes.filter(r => serves(shipped.get(r)!, tags)) };
  });
  const newerThan = (c: Candidate) => round1.filter(o => newer(c.own, o.own) > 0).length;
  // Remotes that agree without being served still take this build's files (rule 5): when no build serves
  // more than itself, that is what separates a build its peers share from an outlier.
  const agreeing = (c: Candidate) => {
    const served = new Set(c.served);
    return remotes.filter(r => !served.has(r) && agrees(shipped.get(r)!, c.tags)).length;
  };
  const first = rank(round1, [
    ...(input.latestFirst ? [newerThan] : []),
    c => c.served.length,
    agreeing,
    c => (c.own.owner === input.previous ? 1 : 0),
  ])!;

  election.winner = first.own.owner;
  for (const [s, tag] of first.tags) coverage.set(s, tag);
  election.global = new Set([election.winner, ...first.served]);

  // A borrowed file is published only from a build that takes every member it ships globally (the fixpoint
  // below drops it otherwise). Where no round-1 remote ships it, its lenders must stay out of any subpool
  // whose build disagrees, or nothing would publish it.
  const shipsAt = (remote: RemoteName, specifier: Specifier, tag: VersionName) =>
    shipped.get(remote)!.some(c => c.tag === tag && c.specifiers.includes(specifier));
  const lenders = new Set<RemoteName>();
  for (const [specifier, from] of first.loans)
    if (![...election.global].some(r => shipsAt(r, specifier, coverage.get(specifier)!)))
      for (const remote of from) lenders.add(remote);

  // Later rounds: subpools of own builds among the remotes still waiting, while one serves at least two.
  let pending = remotes.filter(r => !election.global.has(r));
  const admits = (owner: RemoteName, remote: RemoteName) =>
    remote === owner || !lenders.has(remote) || agrees(shipped.get(owner)!, coverage);
  const formSubpools = () => {
    for (;;) {
      // A tie goes by name, never arrival; see docs/version-resolver.md §"How pooling resolves", step 3.
      const candidates = [...pending]
        .sort(compareStrings)
        .map(owner => {
          const own = buildFor(owner);
          const served = pending.filter(r => serves(shipped.get(r)!, own.tags) && admits(owner, r));
          return { own, served };
        })
        .filter(c => c.served.includes(c.own.owner) && c.served.length >= 2);
      const best = rank(candidates, [c => c.served.length]);
      if (!best) break;
      election.subpools.push({ build: best.own.owner, members: best.served });
      pending = pending.filter(r => !best.served.includes(r));
    }
  };
  formSubpools();

  // A package round 1 does not ship at all is published from the builds that agree with it, when every one
  // of them ships it at one tag, as one tag cannot split it. Last, so it only moves remotes no later round
  // could place in a subpool. A subpool copy resolves globally only when its subpool's build agrees.
  const runnerOf = (remote: RemoteName) =>
    election.subpools.find(p => p.members.includes(remote))?.build ?? remote;
  const contributors = remotes.filter(
    r =>
      !election.global.has(r) &&
      agrees(shipped.get(r)!, coverage) &&
      agrees(shipped.get(runnerOf(r))!, coverage)
  );
  const extras = new Map<string, { tag: VersionName; specifiers: Specifier[] } | null>();
  for (const remote of contributors)
    for (const copy of shipped.get(remote)!)
      for (const s of copy.specifiers) {
        if (coverage.tagOf(s) !== undefined) continue;
        const pkg = owningPackage(s) ?? s;
        const seen = extras.get(pkg);
        if (seen === null) continue;
        if (seen === undefined) extras.set(pkg, { tag: copy.tag, specifiers: [s] });
        else if (seen.tag !== copy.tag) extras.set(pkg, null);
        else seen.specifiers.push(s);
      }
  for (const extra of extras.values())
    if (extra) for (const s of extra.specifiers) coverage.set(s, extra.tag);
  // Whoever the extended coverage now serves resolves globally, in a subpool or not — but a subpool's build
  // only once no other member needs it. A subpool of one is none: its build goes global when served, else
  // serves itself.
  const takesExtended = (remote: RemoteName) =>
    serves(shipped.get(remote)!, coverage) && witnessed(remote);
  for (const remote of pending) if (takesExtended(remote)) election.global.add(remote);
  pending = pending.filter(r => !election.global.has(r));
  for (const subpool of election.subpools) {
    const moved = subpool.members.filter(r => r !== subpool.build && takesExtended(r));
    for (const remote of moved) election.global.add(remote);
    subpool.members = subpool.members.filter(r => !moved.includes(r));
  }
  election.subpools = election.subpools.filter(subpool => {
    if (subpool.members.length >= 2) return true;
    if (takesExtended(subpool.build)) election.global.add(subpool.build);
    else pending.push(subpool.build);
    return false;
  });

  // A published file binds its imports from its owner's scope, so only a build that takes every member it
  // ships from the global map may publish one. Drop what no such build ships until nothing changes; whoever
  // that leaves unserved joins the first subpool whose build serves it, else goes back to the later rounds.
  const runsAll = (build: RemoteName) =>
    agrees(shipped.get(build)!, coverage) &&
    shipped.get(build)!.every(c => c.specifiers.every(s => coverage.tagOf(s) !== undefined));
  const settle = (): boolean => {
    let demoted = false;
    for (;;) {
      const publishers = remotes.filter(r => election.global.has(r) || runsAll(runnerOf(r)));
      const kept = [...coverage].filter(([s, tag]) =>
        publishers.some(r => buildFor(r).tags.get(s) === tag)
      );
      if (kept.length === coverage.size) return demoted;
      coverage.clear();
      for (const [s, tag] of kept) coverage.set(s, tag);
      for (const remote of election.global)
        if (remote !== election.winner && !serves(shipped.get(remote)!, coverage)) {
          election.global.delete(remote);
          const subpool = election.subpools.find(
            p => serves(shipped.get(remote)!, buildFor(p.build).tags) && admits(p.build, remote)
          );
          if (subpool) subpool.members.push(remote);
          else pending.push(remote);
          demoted = true;
        }
    }
  };
  while (settle()) formSubpools();

  election.alone = pending.sort((a, b) => recordOrder.get(a)! - recordOrder.get(b)!);
  for (const remote of [...election.subpools.map(p => p.build), ...election.alone])
    if (agrees(shipped.get(remote)!, coverage)) {
      election.agreeing.add(remote);
      if (runsAll(remote)) election.publishers.add(remote);
    }

  return election;
}
