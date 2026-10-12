import type { ExternalName, PoolCause, RemoteName, VersionName } from 'lib/core/1.domain';
import type { AcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { packageOf, type Specifier, SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import { type Build, buildOf, type Copy, copiesByRemote, type IsChunked } from './builds';
import type { PoolMember } from './membership';
import { agrees, serves, unwitnessedGap } from './rules';
import { compareStrings } from 'lib/utils/compare-strings';

// See docs/version-resolver.md §"How pooling resolves".

type ElectionInput = {
  members: readonly PoolMember[];
  acceptsTag: AcceptsTag;
  compare: (a: VersionName, b: VersionName) => number;
  // The stored record's winner, which breaks round-1 ties.
  previousWinner?: RemoteName;
  latestFirst: boolean;
  isChunked: IsChunked;
};

// `unshipped`: the map serves every specifier, but no build shipped them together.
export type PoolMiss =
  | { cause: 'incompatible'; member: ExternalName; tag: VersionName; strict: boolean }
  | { cause: 'uncovered'; gap: Specifier; unshipped?: true };

// A subpool's owner is placed in its own subpool.
export type Placement =
  { kind: 'global' } | { kind: 'subpool'; owner: RemoteName } | { kind: 'self'; cause: PoolCause };

export type Election = {
  winner: RemoteName;
  winnerIsHost: boolean;
  globalTags: SpecifierTags;
  // Subpool owners and self-serving remotes that agree with the final global tags (rule 5).
  agreeing: ReadonlySet<RemoteName>;
  placements: ReadonlyMap<RemoteName, Placement>;
  // In warning order: subpools in election order, then self. A strict range's rejection wins, as
  // `strictExternalCompatibility` refuses that. Undefined only for a subpool's owner the global map
  // would serve.
  misses: ReadonlyMap<RemoteName, PoolMiss | undefined>;
};

type Subpool = { owner: RemoteName; remotes: RemoteName[] };

type Pool = ElectionInput & {
  shipped: Map<RemoteName, Copy[]>;
  builds: Map<RemoteName, Build>;
  // In record order: the order remotes first appear in the pool's versions, which round 1's ties fall back to.
  remotes: RemoteName[];
  servesAt: (remote: RemoteName, tags: SpecifierTags) => boolean;
  agreesAt: (remote: RemoteName, tags: SpecifierTags) => boolean;
};

// What each step hands the next.
type State = {
  readonly winner: RemoteName;
  globalTags: SpecifierTags;
  globalRemotes: Set<RemoteName>;
  readonly lenders: ReadonlySet<RemoteName>;
  subpools: Subpool[];
  pending: RemoteName[];
};

export function elect(input: ElectionInput): Election {
  const shipped = copiesByRemote(input.members, input.isChunked);
  const builds = new Map<RemoteName, Build>();
  for (const [owner, copies] of shipped) builds.set(owner, buildOf(owner, copies));
  const pool: Pool = {
    ...input,
    shipped,
    builds,
    remotes: [...shipped.keys()],
    servesAt: (remote, tags) => serves(shipped.get(remote)!, tags, input.acceptsTag),
    agreesAt: (remote, tags) => agrees(shipped.get(remote)!, tags),
  };

  // The host cannot be repointed, so its build is the global one whenever it ships any member.
  const hostRemote = pool.remotes.find(r => builds.get(r)!.host);
  const state = roundOne(pool, hostRemote);
  formSubpools(pool, state);
  // Last, so it only moves remotes no later round could place in a subpool.
  extend(pool, state);
  while (settle(pool, state)) formSubpools(pool, state);

  const firstSeen = new Map(pool.remotes.map((r, i) => [r, i]));
  const self = state.pending.sort((a, b) => firstSeen.get(a)! - firstSeen.get(b)!);
  const agreeing = new Set(
    [...state.subpools.map(p => p.owner), ...self].filter(r => pool.agreesAt(r, state.globalTags))
  );
  return {
    winner: state.winner,
    winnerIsHost: hostRemote !== undefined,
    globalTags: state.globalTags,
    agreeing,
    ...placeRemotes(state.globalRemotes, state.subpools, self, r => missOf(pool, state, r)),
  };
}

// The first member both ship, in pool order, whose tags differ decides, so two unrelated version lines are
// never compared.
function newer(pool: Pool, a: Build, b: Build): number {
  for (const { name } of pool.members) {
    const tagA = a.tagByMember.get(name);
    const tagB = b.tagByMember.get(name);
    if (tagA === undefined || tagB === undefined) continue;
    const d = pool.compare(tagA, tagB);
    if (d !== 0) return d;
  }
  return 0;
}

// The sort is stable, so the input order breaks what the keys and the newer build leave tied.
function rank<C extends { build: Build }>(pool: Pool, candidates: C[], keys: ((c: C) => number)[]) {
  const scored = candidates.map(c => ({ c, k: keys.map(key => key(c)) }));
  scored.sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const d = b.k[i]! - a.k[i]!;
      if (d !== 0) return d;
    }
    return newer(pool, b.c.build, a.c.build);
  });
  return scored[0]?.c;
}

// Same tag, same code: round 1 also serves entrypoints other copies of its tags ship — but only from
// builds that agree with it, since a borrowed file binds its own imports where it lives, and never a chunked
// copy's, whose file would bind its build's internals beside the winner's.
function withLoans(pool: Pool, build: Build) {
  const tags = new SpecifierTags(build.tags);
  const loans = new Map<Specifier, RemoteName[]>();
  for (const [remote, copies] of pool.shipped) {
    if (remote === build.owner || !agrees(copies, build.tags)) continue;
    for (const copy of copies) {
      if (copy.chunked) continue;
      for (const specifier of copy.specifiers)
        if (!build.tags.has(specifier) && build.tags.pinnedTag(specifier) === copy.tag) {
          tags.set(specifier, copy.tag);
          loans.set(specifier, [...(loans.get(specifier) ?? []), remote]);
        }
    }
  }
  return { tags, loans };
}

function roundOne(pool: Pool, hostRemote: RemoteName | undefined): State {
  const { remotes } = pool;
  type Candidate = {
    build: Build;
    // The build's tags plus its loans.
    tags: SpecifierTags;
    loans: Map<Specifier, RemoteName[]>;
    served: RemoteName[];
    // Remotes that agree without being served still take this build's files (rule 5): when no build serves
    // more than itself, that is what separates a build its peers share from an outlier.
    agreeing: number;
  };
  const scored = new Map<string, Omit<Candidate, 'build'>>();
  const round1 = (hostRemote ? [hostRemote] : remotes).map<Candidate>(owner => {
    const build = pool.builds.get(owner)!;
    // Keyed in insertion order, which decides `pinnedTag`; an owner's own copies never lend.
    const key = JSON.stringify([[...build.tags], [...build.tagByMember]]);
    let score = scored.get(key);
    if (!score) {
      const { tags, loans } = withLoans(pool, build);
      const served = new Set(remotes.filter(r => pool.servesAt(r, tags)));
      const agreeing = remotes.filter(r => !served.has(r) && pool.agreesAt(r, tags)).length;
      scored.set(key, (score = { tags, loans, served: [...served], agreeing }));
    }
    return { build, ...score };
  });
  const newerThan = (c: Candidate) => round1.filter(o => newer(pool, c.build, o.build) > 0).length;
  const round1Winner = rank(pool, round1, [
    ...(pool.latestFirst ? [newerThan] : []),
    c => c.served.length,
    c => c.agreeing,
    c => (c.build.owner === pool.previousWinner ? 1 : 0),
  ])!;

  const winner = round1Winner.build.owner;
  const globalTags = new SpecifierTags(round1Winner.tags);
  const globalRemotes = new Set([winner, ...round1Winner.served]);

  // A borrowed file is published only from a build that takes every member it ships globally (the fixpoint
  // below drops it otherwise). Where no round-1 remote ships it, its lenders must stay out of any subpool
  // whose owner disagrees, or nothing would publish it.
  const shipsAt = (remote: RemoteName, specifier: Specifier, tag: VersionName) =>
    pool.shipped.get(remote)!.some(c => c.tag === tag && c.specifiers.includes(specifier));
  const lenders = new Set<RemoteName>();
  for (const [specifier, from] of round1Winner.loans)
    if (![...globalRemotes].some(r => shipsAt(r, specifier, globalTags.get(specifier)!)))
      for (const remote of from) lenders.add(remote);

  const pending = remotes.filter(r => !globalRemotes.has(r));
  return { winner, globalTags, globalRemotes, lenders, subpools: [], pending };
}

function mayJoin(pool: Pool, state: State, owner: RemoteName, remote: RemoteName): boolean {
  return remote === owner || !state.lenders.has(remote) || pool.agreesAt(owner, state.globalTags);
}

function formSubpools(pool: Pool, state: State): void {
  // The global tags hold still within a call and pending only shrinks, so who each build serves is found once.
  const servable = new Map(
    state.pending.map(owner => {
      const build = pool.builds.get(owner)!;
      const served = state.pending.filter(
        r => pool.servesAt(r, build.tags) && mayJoin(pool, state, owner, r)
      );
      return [owner, { build, served }];
    })
  );
  for (;;) {
    const stillPending = new Set(state.pending);
    // A tie goes by name, never record order; see docs/version-resolver.md §"How pooling resolves", step 3.
    const candidates = [...state.pending]
      .sort(compareStrings)
      .map(owner => {
        const { build, served } = servable.get(owner)!;
        return { build, served: served.filter(r => stillPending.has(r)) };
      })
      .filter(c => c.served.includes(c.build.owner) && c.served.length >= 2);
    const best = rank(pool, candidates, [c => c.served.length]);
    if (!best) break;
    state.subpools.push({ owner: best.build.owner, remotes: best.served });
    state.pending = state.pending.filter(r => !best.served.includes(r));
  }
}

function extend(pool: Pool, state: State): void {
  const { globalTags, globalRemotes } = state;
  addExtensions(pool, state);
  // Whoever the extended global tags now serve resolves globally, in a subpool or not — but a subpool's owner
  // only once no other member needs it. A subpool of one is none: its owner goes global when served, else
  // serves itself.
  const takesExtended = (remote: RemoteName) =>
    pool.servesAt(remote, globalTags) &&
    unwitnessedGap(pool.shipped.get(remote)!, globalTags, pool.builds.values()) === undefined;
  for (const remote of state.pending) if (takesExtended(remote)) globalRemotes.add(remote);
  state.pending = state.pending.filter(r => !globalRemotes.has(r));
  for (const subpool of state.subpools) {
    const moved = subpool.remotes.filter(r => r !== subpool.owner && takesExtended(r));
    for (const remote of moved) globalRemotes.add(remote);
    subpool.remotes = subpool.remotes.filter(r => !moved.includes(r));
  }
  state.subpools = state.subpools.filter(subpool => {
    if (subpool.remotes.length >= 2) return true;
    if (takesExtended(subpool.owner)) globalRemotes.add(subpool.owner);
    else state.pending.push(subpool.owner);
    return false;
  });
}

// A package round 1 does not ship at all is published from the builds that agree with it, when every one
// of them ships it at one tag, as one tag cannot split it. A subpool copy resolves globally only when its
// subpool's owner agrees. Under a host, the agreeing members of subpools whose build disagrees with the
// host then fill the packages still missing, so they can move onto the host's runtime.
function addExtensions(pool: Pool, state: State): void {
  const { globalTags, globalRemotes } = state;
  const runsOn = (remote: RemoteName) =>
    state.subpools.find(p => p.remotes.includes(remote))?.owner ?? remote;
  const agreeing = pool.remotes.filter(r => !globalRemotes.has(r) && pool.agreesAt(r, globalTags));
  const runsGlobally = (remote: RemoteName) => pool.agreesAt(runsOn(remote), globalTags);
  const contributors = agreeing.filter(runsGlobally);
  const offered = offers(pool, globalTags, contributors);
  const fill = pool.builds.get(state.winner)!.host ? agreeing.filter(r => !runsGlobally(r)) : [];
  for (const [pkg, offer] of offers(pool, globalTags, fill))
    if (!offered.has(pkg)) offered.set(pkg, offer);
  // A fill remote that goes global publishes its copy too, so the guard covers it.
  dropChunkedSplits(pool, [...contributors, ...fill], offered);
  for (const offer of offered.values())
    if (offer) for (const s of offer.specifiers) globalTags.set(s, offer.tag);
}

type Offer = { tag: VersionName; specifiers: Specifier[] };

// Per package the contributors ship and the global tags do not pin: its one tag, or null for two.
function offers(pool: Pool, globalTags: SpecifierTags, contributors: RemoteName[]) {
  const offered = new Map<string, Offer | null>();
  for (const remote of contributors)
    for (const copy of pool.shipped.get(remote)!)
      for (const s of copy.specifiers) {
        if (globalTags.pinnedTag(s) !== undefined) continue;
        const pkg = packageOf(s);
        const seen = offered.get(pkg);
        if (seen === null) continue;
        if (seen === undefined) offered.set(pkg, { tag: copy.tag, specifiers: [s] });
        else if (seen.tag !== copy.tag) offered.set(pkg, null);
        else seen.specifiers.push(s);
      }
  return offered;
}

// A chunked copy's files run only beside its own build's, so two contributors' copies of a chunked package
// may be published only when the map cannot mix them: each ships the same entrypoints in one member, whose
// row the map claims whole. Flat members are claimed one row each, in record order, so they can mix.
function dropChunkedSplits(
  pool: Pool,
  contributors: RemoteName[],
  offered: Map<string, Offer | null>
): void {
  const shapes = new Map<string, Set<string>>();
  const chunked = new Set<string>();
  for (const remote of contributors) {
    const packages = packagesOf(pool.shipped.get(remote)!, offered, chunked);
    for (const [pkg, { specifiers, members }] of packages) {
      let sets = shapes.get(pkg);
      if (!sets) shapes.set(pkg, (sets = new Set()));
      // A copy split over members gets a shape no other contributor matches.
      sets.add(members.size > 1 ? `flat ${remote}` : specifiers.sort().join(' '));
    }
  }
  for (const pkg of chunked) if (shapes.get(pkg)!.size > 1) offered.set(pkg, null);
}

// Also collects the chunked packages into `chunked`.
function packagesOf(
  copies: Copy[],
  offered: Map<string, Offer | null>,
  chunked: Set<string>
): Map<string, { specifiers: Specifier[]; members: Set<string> }> {
  const packages = new Map<string, { specifiers: Specifier[]; members: Set<string> }>();
  for (const copy of copies)
    for (const s of copy.specifiers) {
      const pkg = packageOf(s);
      // A fill copy at another tag than the offer is never published.
      if (offered.get(pkg)?.tag !== copy.tag) continue;
      let own = packages.get(pkg);
      if (!own) packages.set(pkg, (own = { specifiers: [], members: new Set() }));
      own.specifiers.push(s);
      own.members.add(copy.member);
      if (copy.chunked) chunked.add(pkg);
    }
  return packages;
}

// The global map publishes only global remotes' copies, so drop each tag no global remote ships until
// nothing changes; whoever that leaves unserved joins the first subpool whose owner serves it, else goes
// back to the later rounds.
function settle(pool: Pool, state: State): boolean {
  const { globalTags, globalRemotes } = state;
  let demoted = false;
  for (;;) {
    const publishers = pool.remotes.filter(r => globalRemotes.has(r));
    const kept = [...globalTags].filter(([s, tag]) =>
      publishers.some(r => pool.builds.get(r)!.tags.get(s) === tag)
    );
    if (kept.length === globalTags.size) return demoted;
    globalTags.clear();
    for (const [s, tag] of kept) globalTags.set(s, tag);
    for (const remote of globalRemotes)
      if (remote !== state.winner && !pool.servesAt(remote, globalTags)) {
        globalRemotes.delete(remote);
        const subpool = state.subpools.find(
          p =>
            pool.servesAt(remote, pool.builds.get(p.owner)!.tags) &&
            mayJoin(pool, state, p.owner, remote)
        );
        if (subpool) subpool.remotes.push(remote);
        else state.pending.push(remote);
        demoted = true;
      }
  }
}

function missOf(pool: Pool, state: State, remote: RemoteName): PoolMiss | undefined {
  const { globalTags } = state;
  const copies = pool.shipped.get(remote)!;
  let rejected: PoolMiss | undefined;
  for (const copy of copies)
    for (const s of copy.specifiers) {
      const tag = globalTags.get(s);
      if (tag === undefined || pool.acceptsTag(tag, copy.tag, copy.requiredVersion)) continue;
      if (copy.strict) return { cause: 'incompatible', member: copy.member, tag, strict: true };
      rejected ??= { cause: 'incompatible', member: copy.member, tag, strict: false };
    }
  if (rejected) return rejected;
  for (const copy of copies)
    for (const s of copy.specifiers) if (!globalTags.has(s)) return { cause: 'uncovered', gap: s };
  const gap = unwitnessedGap(copies, globalTags, pool.builds.values());
  if (gap) return { cause: 'uncovered', gap, unshipped: true };
  // Everyone else the extended global tags serve is global, so only a subpool's owner can lack a reason.
  if (state.subpools.some(p => p.owner === remote)) return undefined;
  throw new Error(`'${remote}' missed the global map with nothing it rejects or lacks.`);
}

// A member that joined since carries no winner yet; only two stored winners that conflict void it.
export function previousWinner(members: PoolMember[]): RemoteName | undefined {
  const winners = new Set(members.flatMap(m => m.external.poolWinner ?? []));
  const [winner] = winners;
  if (winners.size !== 1) return undefined;
  const ships = members.some(m =>
    m.external.versions.some(v => v.remotes.some(r => r.name === winner))
  );
  return ships ? winner : undefined;
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
  for (const { owner, remotes } of subpools)
    for (const remote of remotes) placements.set(remote, { kind: 'subpool', owner });
  for (const remote of self)
    placements.set(remote, { kind: 'self', cause: misses.get(remote)!.cause });
  return { placements, misses };
}
