import type { ExternalName, PoolCause, RemoteName, VersionName } from 'lib/core/1.domain';
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

type ElectionInput = {
  members: readonly PoolMember[];
  acceptsTag: AcceptsTag;
  compare: (a: VersionName, b: VersionName) => number;
  // The round-1 winner the stored record carries from the last election, for the tie rule.
  previous?: RemoteName;
  latestFirst: boolean;
};

// Why a remote missed round 1. `with`: the specifiers no build shipped together with `gap`, for a remote the
// map serves but no build witnesses.
export type PoolMiss =
  | { cause: 'incompatible'; member: ExternalName; tag: VersionName; strict: boolean }
  | { cause: 'uncovered'; gap: Specifier; with?: Specifier[] };

// A subpool's build runs its own build too.
export type Placement =
  { kind: 'global' } | { kind: 'subpool'; build: RemoteName } | { kind: 'self'; cause: PoolCause };

export type Election = {
  winner: RemoteName;
  winnerIsHost: boolean;
  // The winner's specifiers, same-tag loans from agreeing builds, and packages they all add at one tag.
  globalTags: SpecifierTags;
  // Remotes outside round 1 that agree with the winner on everything both ship (rule 5).
  agreeing: ReadonlySet<RemoteName>;
  placements: ReadonlyMap<RemoteName, Placement>;
  // Every remote off the global map, in the warning order (subpools in election order, then self): a
  // rejected tag (a strict range's first, as `strictExternalCompatibility` refuses that), else a gap, else
  // specifiers no one build shipped together. Undefined only for a subpool's build the global map would serve.
  misses: ReadonlyMap<RemoteName, PoolMiss | undefined>;
};

type Subpool = { build: RemoteName; remotes: RemoteName[] };

export function elect(input: ElectionInput): Election {
  const { members, acceptsTag, compare } = input;

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
  const withSameTagEntries = (build: Build) => {
    const tags = new SpecifierTags(build.tags);
    const loans = new Map<Specifier, RemoteName[]>();
    for (const [remote, copies] of shipped) {
      if (remote === build.owner || !agrees(copies, build.tags)) continue;
      for (const copy of copies)
        for (const specifier of copy.specifiers)
          if (!build.tags.has(specifier) && build.tags.tagOf(specifier) === copy.tag) {
            tags.set(specifier, copy.tag);
            loans.set(specifier, [...(loans.get(specifier) ?? []), remote]);
          }
    }
    return { tags, loans };
  };

  const serves = (copies: readonly Copy[], tags: SpecifierTags) =>
    servesAt(copies, tags, acceptsTag);
  const witnessed = (remote: RemoteName) =>
    shippedTogether(shipped.get(remote)!, globalTags, builds.values());
  // The first specifier no build ships next to the ones before it, and a smallest set of those it clashes with.
  const unwitnessed = (remote: RemoteName) => {
    const specifiers = shipped.get(remote)!.flatMap(c => c.specifiers);
    const matches = [...shipped.keys()].map(owner => {
      const { tags } = buildFor(owner);
      return specifiers.map(s => tags.tagOf(s) === globalTags.get(s));
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
  const firstSeen = new Map(remotes.map((r, i) => [r, i]));

  // Highest first on every key, then the newer build; the sort is stable, so the input order breaks the rest.
  const rank = <C extends { build: Build }>(candidates: C[], keys: ((c: C) => number)[]) => {
    const scored = candidates.map(c => ({ c, k: keys.map(key => key(c)) }));
    scored.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const d = b.k[i]! - a.k[i]!;
        if (d !== 0) return d;
      }
      return newer(b.c.build, a.c.build);
    });
    return scored[0]?.c;
  };

  const globalTags = new SpecifierTags();
  let subpools: Subpool[] = [];
  const missOf = (remote: RemoteName): PoolMiss | undefined => {
    let rejected: PoolMiss | undefined;
    for (const copy of shipped.get(remote)!)
      for (const s of copy.specifiers) {
        const tag = globalTags.get(s);
        if (tag === undefined || acceptsTag(tag, copy.tag, copy.requiredVersion)) continue;
        if (copy.strict) return { cause: 'incompatible', member: copy.member, tag, strict: true };
        rejected ??= { cause: 'incompatible', member: copy.member, tag, strict: false };
      }
    if (rejected) return rejected;
    for (const copy of shipped.get(remote)!)
      for (const s of copy.specifiers)
        if (!globalTags.has(s)) return { cause: 'uncovered', gap: s };
    const torn = unwitnessed(remote);
    if (torn) return { cause: 'uncovered', ...torn };
    // Everyone else the extended coverage serves is global, so only a subpool's build can lack a reason.
    if (subpools.some(p => p.build === remote)) return undefined;
    throw new Error(`'${remote}' missed the global map with nothing it rejects or lacks.`);
  };

  // Round 1. The host cannot be repointed, so its build is the global one whenever it ships any member.
  const hostRemote = remotes.find(r => buildFor(r).host);
  type Candidate = {
    build: Build;
    // The build's tags plus its loans.
    tags: SpecifierTags;
    loans: Map<Specifier, RemoteName[]>;
    served: RemoteName[];
  };
  const round1 = (hostRemote ? [hostRemote] : remotes).map<Candidate>(owner => {
    const build = buildFor(owner);
    const { tags, loans } = withSameTagEntries(build);
    return { build, tags, loans, served: remotes.filter(r => serves(shipped.get(r)!, tags)) };
  });
  const newerThan = (c: Candidate) => round1.filter(o => newer(c.build, o.build) > 0).length;
  // Remotes that agree without being served still take this build's files (rule 5): when no build serves
  // more than itself, that is what separates a build its peers share from an outlier.
  const agreeingCount = (c: Candidate) => {
    const served = new Set(c.served);
    return remotes.filter(r => !served.has(r) && agrees(shipped.get(r)!, c.tags)).length;
  };
  const round1Winner = rank(round1, [
    ...(input.latestFirst ? [newerThan] : []),
    c => c.served.length,
    agreeingCount,
    c => (c.build.owner === input.previous ? 1 : 0),
  ])!;

  const winner = round1Winner.build.owner;
  for (const [s, tag] of round1Winner.tags) globalTags.set(s, tag);
  const globalRemotes = new Set([winner, ...round1Winner.served]);

  // A borrowed file is published only from a build that takes every member it ships globally (the fixpoint
  // below drops it otherwise). Where no round-1 remote ships it, its lenders must stay out of any subpool
  // whose build disagrees, or nothing would publish it.
  const shipsAt = (remote: RemoteName, specifier: Specifier, tag: VersionName) =>
    shipped.get(remote)!.some(c => c.tag === tag && c.specifiers.includes(specifier));
  const lenders = new Set<RemoteName>();
  for (const [specifier, from] of round1Winner.loans)
    if (![...globalRemotes].some(r => shipsAt(r, specifier, globalTags.get(specifier)!)))
      for (const remote of from) lenders.add(remote);

  // Later rounds: subpools of own builds among the remotes still waiting, while one serves at least two.
  let pending = remotes.filter(r => !globalRemotes.has(r));
  const admits = (owner: RemoteName, remote: RemoteName) =>
    remote === owner || !lenders.has(remote) || agrees(shipped.get(owner)!, globalTags);
  const formSubpools = () => {
    // The global tags hold still within a call and pending only shrinks, so who each build serves is found once.
    const servable = new Map(
      pending.map(owner => {
        const build = buildFor(owner);
        const served = pending.filter(r => serves(shipped.get(r)!, build.tags) && admits(owner, r));
        return [owner, { build, served }];
      })
    );
    for (;;) {
      const waiting = new Set(pending);
      // A tie goes by name, never record order; see docs/version-resolver.md §"How pooling resolves", step 3.
      const candidates = [...pending]
        .sort(compareStrings)
        .map(owner => {
          const { build, served } = servable.get(owner)!;
          return { build, served: served.filter(r => waiting.has(r)) };
        })
        .filter(c => c.served.includes(c.build.owner) && c.served.length >= 2);
      const best = rank(candidates, [c => c.served.length]);
      if (!best) break;
      subpools.push({ build: best.build.owner, remotes: best.served });
      pending = pending.filter(r => !best.served.includes(r));
    }
  };
  formSubpools();

  // A package round 1 does not ship at all is published from the builds that agree with it, when every one
  // of them ships it at one tag, as one tag cannot split it. Last, so it only moves remotes no later round
  // could place in a subpool. A subpool copy resolves globally only when its subpool's build agrees.
  const runsOn = (remote: RemoteName) =>
    subpools.find(p => p.remotes.includes(remote))?.build ?? remote;
  const contributors = remotes.filter(
    r =>
      !globalRemotes.has(r) &&
      agrees(shipped.get(r)!, globalTags) &&
      agrees(shipped.get(runsOn(r))!, globalTags)
  );
  const extras = new Map<string, { tag: VersionName; specifiers: Specifier[] } | null>();
  for (const remote of contributors)
    for (const copy of shipped.get(remote)!)
      for (const s of copy.specifiers) {
        if (globalTags.tagOf(s) !== undefined) continue;
        const pkg = owningPackage(s) ?? s;
        const seen = extras.get(pkg);
        if (seen === null) continue;
        if (seen === undefined) extras.set(pkg, { tag: copy.tag, specifiers: [s] });
        else if (seen.tag !== copy.tag) extras.set(pkg, null);
        else seen.specifiers.push(s);
      }
  for (const extra of extras.values())
    if (extra) for (const s of extra.specifiers) globalTags.set(s, extra.tag);
  // Whoever the extended coverage now serves resolves globally, in a subpool or not — but a subpool's build
  // only once no other member needs it. A subpool of one is none: its build goes global when served, else
  // serves itself.
  const takesExtended = (remote: RemoteName) =>
    serves(shipped.get(remote)!, globalTags) && witnessed(remote);
  for (const remote of pending) if (takesExtended(remote)) globalRemotes.add(remote);
  pending = pending.filter(r => !globalRemotes.has(r));
  for (const subpool of subpools) {
    const moved = subpool.remotes.filter(r => r !== subpool.build && takesExtended(r));
    for (const remote of moved) globalRemotes.add(remote);
    subpool.remotes = subpool.remotes.filter(r => !moved.includes(r));
  }
  subpools = subpools.filter(subpool => {
    if (subpool.remotes.length >= 2) return true;
    if (takesExtended(subpool.build)) globalRemotes.add(subpool.build);
    else pending.push(subpool.build);
    return false;
  });

  // A published file binds its imports from its owner's scope, so only a build that takes every member it
  // ships from the global map may publish one. Drop what no such build ships until nothing changes; whoever
  // that leaves unserved joins the first subpool whose build serves it, else goes back to the later rounds.
  const runsAll = (build: RemoteName) =>
    agrees(shipped.get(build)!, globalTags) &&
    shipped.get(build)!.every(c => c.specifiers.every(s => globalTags.tagOf(s) !== undefined));
  const settle = (): boolean => {
    let demoted = false;
    for (;;) {
      const publishers = remotes.filter(r => globalRemotes.has(r) || runsAll(runsOn(r)));
      const kept = [...globalTags].filter(([s, tag]) =>
        publishers.some(r => buildFor(r).tags.get(s) === tag)
      );
      if (kept.length === globalTags.size) return demoted;
      globalTags.clear();
      for (const [s, tag] of kept) globalTags.set(s, tag);
      for (const remote of globalRemotes)
        if (remote !== winner && !serves(shipped.get(remote)!, globalTags)) {
          globalRemotes.delete(remote);
          const subpool = subpools.find(
            p => serves(shipped.get(remote)!, buildFor(p.build).tags) && admits(p.build, remote)
          );
          if (subpool) subpool.remotes.push(remote);
          else pending.push(remote);
          demoted = true;
        }
    }
  };
  while (settle()) formSubpools();

  const self = pending.sort((a, b) => firstSeen.get(a)! - firstSeen.get(b)!);
  const agreeing = new Set(
    [...subpools.map(p => p.build), ...self].filter(r => agrees(shipped.get(r)!, globalTags))
  );
  return {
    winner,
    winnerIsHost: hostRemote !== undefined,
    globalTags,
    agreeing,
    ...placeRemotes(globalRemotes, subpools, self, missOf),
  };
}

function placeRemotes(
  globalRemotes: ReadonlySet<RemoteName>,
  subpools: readonly Subpool[],
  self: readonly RemoteName[],
  missOf: (remote: RemoteName) => PoolMiss | undefined
): Pick<Election, 'placements' | 'misses'> {
  const misses = new Map<RemoteName, PoolMiss | undefined>();
  for (const remote of [...subpools.flatMap(p => p.remotes), ...self])
    misses.set(remote, missOf(remote));
  const placements = new Map<RemoteName, Placement>();
  for (const remote of globalRemotes) placements.set(remote, { kind: 'global' });
  for (const { build, remotes } of subpools)
    for (const remote of remotes) placements.set(remote, { kind: 'subpool', build });
  for (const remote of self)
    placements.set(remote, { kind: 'self', cause: misses.get(remote)!.cause });
  return { placements, misses };
}
