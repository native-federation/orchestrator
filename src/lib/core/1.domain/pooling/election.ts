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
  packages: Map<RemoteName, Map<string, PackageCopy | null>>;
  // In record order: the order remotes first appear in the pool's versions.
  remotes: RemoteName[];
  servesAt: (remote: RemoteName, tags: SpecifierTags) => boolean;
  agreesAt: (remote: RemoteName, tags: SpecifierTags) => boolean;
};

// What each step hands the next.
type State = {
  readonly winner: RemoteName;
  globalTags: SpecifierTags;
  globalRemotes: Set<RemoteName>;
  // The packages the winner does not ship that the global tags publish.
  extensions: Set<string>;
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
    packages: new Map([...shipped].map(([owner, copies]) => [owner, packageCopies(owner, copies)])),
    remotes: [...shipped.keys()],
    servesAt: (remote, tags) => serves(shipped.get(remote)!, tags, input.acceptsTag),
    agreesAt: (remote, tags) => agrees(shipped.get(remote)!, tags),
  };

  // The host cannot be repointed, so its build is the global one whenever it ships any member.
  const hostRemote = pool.remotes.find(r => builds.get(r)!.host);
  const state = roundOne(pool, hostRemote);
  formSubpools(pool, state);
  // Last, so it only moves remotes no later round could place in a subpool.
  addExtensions(pool, state);
  promote(pool, state);
  while (settle(pool, state)) formSubpools(pool, state);

  const firstSeen = new Map(pool.remotes.map((r, i) => [r, i]));
  const self = state.pending.sort((a, b) => firstSeen.get(a)! - firstSeen.get(b)!);
  return {
    winner: state.winner,
    winnerIsHost: hostRemote !== undefined,
    globalTags: state.globalTags,
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

// What the keys leave tied goes to the newer build, then to the name that sorts first. `newer` ties unrelated
// builds, so three can still rank in a cycle; presorting by name keeps record order out of that too.
function rank<C extends { build: Build }>(pool: Pool, candidates: C[], keys: ((c: C) => number)[]) {
  const scored = [...candidates]
    .sort((a, b) => compareStrings(a.build.owner, b.build.owner))
    .map(c => ({ c, k: keys.map(key => key(c)) }));
  scored.sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const d = b.k[i]! - a.k[i]!;
      if (d !== 0) return d;
    }
    return newer(pool, b.c.build, a.c.build) || compareStrings(a.c.build.owner, b.c.build.owner);
  });
  return scored[0]?.c;
}

function roundOne(pool: Pool, hostRemote: RemoteName | undefined): State {
  const { remotes } = pool;
  type Candidate = {
    build: Build;
    served: RemoteName[];
    // Remotes that agree without being served: when no build serves more than itself, they separate a build
    // its peers share from an outlier.
    agreeing: number;
  };
  const scored = new Map<string, Omit<Candidate, 'build'>>();
  const round1 = (hostRemote ? [hostRemote] : remotes).map<Candidate>(owner => {
    const build = pool.builds.get(owner)!;
    // Keyed in insertion order, which decides `pinnedTag`.
    const key = JSON.stringify([[...build.tags], [...build.tagByMember]]);
    let score = scored.get(key);
    if (!score) {
      const served = new Set(remotes.filter(r => pool.servesAt(r, build.tags)));
      const agreeing = remotes.filter(r => !served.has(r) && pool.agreesAt(r, build.tags)).length;
      scored.set(key, (score = { served: [...served], agreeing }));
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
  const globalTags = new SpecifierTags(round1Winner.build.tags);
  const globalRemotes = new Set([winner, ...round1Winner.served]);

  const pending = remotes.filter(r => !globalRemotes.has(r));
  return { winner, globalTags, globalRemotes, extensions: new Set(), subpools: [], pending };
}

function formSubpools(pool: Pool, state: State): void {
  // The global tags hold still within a call and pending only shrinks, so who each build serves is found once.
  const servable = new Map(
    state.pending.map(owner => {
      const build = pool.builds.get(owner)!;
      const served = state.pending.filter(r => pool.servesAt(r, build.tags));
      return [owner, { build, served }];
    })
  );
  for (;;) {
    const stillPending = new Set(state.pending);
    const candidates = state.pending
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

function promote(pool: Pool, state: State): void {
  const { globalTags, globalRemotes } = state;
  // Whoever the global tags now serve resolves globally, in a subpool or not — but a subpool's owner only once
  // no other member needs it. A subpool of one is none: its owner goes global when served, else serves itself.
  const takesGlobal = (remote: RemoteName) =>
    pool.servesAt(remote, globalTags) &&
    unwitnessedGap(pool.shipped.get(remote)!, globalTags, pool.builds.values()) === undefined;
  for (const remote of state.pending) if (takesGlobal(remote)) globalRemotes.add(remote);
  state.pending = state.pending.filter(r => !globalRemotes.has(r));
  for (const subpool of state.subpools) {
    const moved = subpool.remotes.filter(r => r !== subpool.owner && takesGlobal(r));
    for (const remote of moved) globalRemotes.add(remote);
    subpool.remotes = subpool.remotes.filter(r => !moved.includes(r));
  }
  state.subpools = state.subpools.filter(subpool => {
    if (subpool.remotes.length >= 2) return true;
    if (takesGlobal(subpool.owner)) globalRemotes.add(subpool.owner);
    else state.pending.push(subpool.owner);
    return false;
  });
}

// A package round 1 does not ship at all is published from one build that agrees with the global tags, so it
// runs whole from that build: the copy that contains the most others. A subpool copy resolves globally only
// when its subpool's owner agrees. Under a host, the agreeing members of subpools whose build disagrees with
// the host then offer the packages still missing, so they can move onto the host's runtime.
function addExtensions(pool: Pool, state: State): void {
  const { globalTags, globalRemotes } = state;
  const runsOn = (remote: RemoteName) =>
    state.subpools.find(p => p.remotes.includes(remote))?.owner ?? remote;
  const agreeing = pool.remotes.filter(r => !globalRemotes.has(r) && pool.agreesAt(r, globalTags));
  const runsGlobally = (remote: RemoteName) => pool.agreesAt(runsOn(remote), globalTags);
  const offered = offers(pool, globalTags, agreeing.filter(runsGlobally));
  const fill = pool.builds.get(state.winner)!.host ? agreeing.filter(r => !runsGlobally(r)) : [];
  for (const [pkg, offer] of offers(pool, globalTags, fill))
    if (!offered.has(pkg)) offered.set(pkg, offer);
  for (const [pkg, offer] of offered) {
    if (!offer) continue;
    state.extensions.add(pkg);
    for (const s of offer.specifiers) globalTags.set(s, offer.tag);
  }
}

type PackageCopy = { owner: RemoteName; tag: VersionName; specifiers: Set<Specifier> };

// A remote's copy of each package, or null where it ships the package at two tags.
function packageCopies(
  owner: RemoteName,
  copies: readonly Copy[]
): Map<string, PackageCopy | null> {
  const packages = new Map<string, PackageCopy | null>();
  for (const copy of copies)
    for (const s of copy.specifiers) {
      const pkg = packageOf(s);
      const seen = packages.get(pkg);
      if (seen === undefined) packages.set(pkg, { owner, tag: copy.tag, specifiers: new Set([s]) });
      else if (seen && seen.tag !== copy.tag) packages.set(pkg, null);
      else seen?.specifiers.add(s);
    }
  return packages;
}

// Per package the remotes ship and the global tags do not pin: the copy chosen to publish it, or null when
// they ship it at two tags.
function offers(pool: Pool, globalTags: SpecifierTags, remotes: RemoteName[]) {
  const candidates = new Map<string, (PackageCopy | null)[]>();
  for (const owner of remotes)
    for (const [pkg, copy] of pool.packages.get(owner)!)
      if (globalTags.pinnedTag(pkg) === undefined)
        candidates.set(pkg, [...(candidates.get(pkg) ?? []), copy]);
  const offered = new Map<string, PackageCopy | null>();
  for (const [pkg, copies] of candidates)
    offered.set(pkg, oneTag(copies) ? coveringCopy(copies) : null);
  return offered;
}

const oneTag = (copies: (PackageCopy | null)[]): copies is PackageCopy[] =>
  copies.every(c => c !== null && c.tag === copies[0]!.tag);

// The copy that contains the most others, then the widest; ties go to the name that sorts first.
function coveringCopy(candidates: PackageCopy[]): PackageCopy {
  const scored = candidates.map(c => ({
    c,
    covers: candidates.filter(o => contains(c.specifiers, o.specifiers)).length,
  }));
  scored.sort(
    (a, b) =>
      b.covers - a.covers ||
      b.c.specifiers.size - a.c.specifiers.size ||
      compareStrings(a.c.owner, b.c.owner)
  );
  return scored[0]!.c;
}

const contains = (a: ReadonlySet<Specifier>, b: ReadonlySet<Specifier>) =>
  [...b].every(s => a.has(s));

// The global map publishes a package the winner does not ship only while a global remote ships a copy of
// exactly its tags: the chosen one or another, as the same files at one tag are the same code. Otherwise the
// package's tags drop, whole; whoever that leaves unserved joins the first subpool whose owner serves it,
// else goes back to the later rounds.
function settle(pool: Pool, state: State): boolean {
  const { globalTags, globalRemotes, extensions } = state;
  let demoted = false;
  for (;;) {
    const dropped = new Set([...extensions].filter(pkg => !publishedWhole(pool, state, pkg)));
    if (dropped.size === 0) return demoted;
    for (const pkg of dropped) extensions.delete(pkg);
    const kept = [...globalTags].filter(([s]) => !dropped.has(packageOf(s)));
    globalTags.clear();
    for (const [s, tag] of kept) globalTags.set(s, tag);
    for (const remote of globalRemotes)
      if (remote !== state.winner && !pool.servesAt(remote, globalTags)) {
        globalRemotes.delete(remote);
        const subpool = state.subpools.find(p =>
          pool.servesAt(remote, pool.builds.get(p.owner)!.tags)
        );
        if (subpool) subpool.remotes.push(remote);
        else state.pending.push(remote);
        demoted = true;
      }
  }
}

function publishedWhole(pool: Pool, state: State, pkg: string): boolean {
  const published = new Set([...state.globalTags.keys()].filter(s => packageOf(s) === pkg));
  const tag = state.globalTags.pinnedTag(pkg);
  return [...state.globalRemotes].some(remote => {
    const copy = pool.packages.get(remote)!.get(pkg);
    return (
      !!copy &&
      copy.tag === tag &&
      copy.specifiers.size === published.size &&
      contains(copy.specifiers, published)
    );
  });
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
  // Everyone else the final global tags serve is global, so only a subpool's owner can lack a reason.
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
