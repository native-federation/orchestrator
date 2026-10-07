import type { ExternalName, RemoteName, VersionName } from 'lib/core/1.domain';
import type { AcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import {
  owningPackage,
  type Specifier,
  SpecifierTags,
} from 'lib/core/1.domain/externals/specifier';
import type { PoolMember } from './membership';
import { compareStrings } from 'lib/utils/compare-strings';

// Who serves each remote of one pool, keyed by specifier; pure, `pool-shared-externals.ts` turns it into
// verdicts. See docs/version-resolver.md §"How pooling resolves".

type Copy = {
  member: ExternalName;
  tag: VersionName;
  requiredVersion: string;
  strict: boolean;
  specifiers: Specifier[];
};

// One build's whole family, as it shipped it, per specifier.
type Variant = {
  owner: RemoteName;
  tags: SpecifierTags;
  // The tag it ships each member at, for comparing builds member by member.
  instance: Map<ExternalName, VersionName>;
  // Entrypoints round 1 borrowed, and every agreeing build that ships them at the borrowed tag.
  loans?: Map<Specifier, RemoteName[]>;
};

export type ElectionInput = {
  members: PoolMember[];
  acceptsTag: AcceptsTag;
  hosts: ReadonlySet<RemoteName>;
  arrival: ReadonlyMap<RemoteName, number>;
  compare: (a: VersionName, b: VersionName) => number;
  // The round-1 winner the stored record carries from the last election, for the tie rule.
  previous?: RemoteName;
  latestFirst: boolean;
};

export type Election = {
  /** Round 1: the build the global map is elected from. Undefined only for a pool with no copies. */
  winner?: RemoteName;
  /**
   * Every specifier round 1 serves and its tag: the winner's own, same-tag copies of agreeing builds, and
   * packages the winner lacks that every agreeing build ships at one tag.
   */
  coverage: SpecifierTags;
  /** Everyone the global map serves, the winner included: round 1, then whoever the extension serves. */
  global: Set<RemoteName>;
  /** Later rounds, in election order: each subpool, the remote whose build it runs among its members. */
  subpools: { build: RemoteName; members: RemoteName[] }[];
  /** Remotes no round served. */
  alone: RemoteName[];
  /** Remotes outside round 1 that agree with the winner on everything both ship (rule 5). */
  agreeing: Set<RemoteName>;
  /** The tag round 1 publishes a specifier at, falling back to its package's: what rule 5 compares against. */
  tagOf: (specifier: Specifier) => VersionName | undefined;
  /**
   * Why a remote is off the global map: a tag its range rejects (a strict range's first, as that is what
   * `strictExternalCompatibility` refuses), else a specifier it does not serve, else a set of its
   * specifiers no one build shipped at the tags served — `gap` completing it. Undefined for a
   * subpool's build the global map would serve: it stays only for the members that need it.
   */
  missOf: (
    remote: RemoteName
  ) =>
    | { rejected: { member: ExternalName; tag: VersionName; strict: boolean } }
    | { gap: Specifier }
    | { unwitnessed: { gap: Specifier; with: Specifier[] } }
    | undefined;
};

export function electVariants(input: ElectionInput): Election {
  const { members, acceptsTag, hosts, arrival, compare } = input;

  const own = new Map<RemoteName, Copy[]>();
  for (const member of members)
    for (const version of member.external.versions)
      for (const meta of version.remotes) {
        let copies = own.get(meta.name);
        if (!copies) own.set(meta.name, (copies = []));
        // A remote ships one copy per member; first wins so a malformed record still reads deterministically.
        if (!copies.some(c => c.member === member.name))
          copies.push({
            member: member.name,
            tag: version.tag,
            requiredVersion: meta.requiredVersion,
            strict: meta.strictVersion,
            specifiers: Object.keys(meta.entries),
          });
      }

  const variantOf = (owner: RemoteName): Variant => {
    const tags = new SpecifierTags();
    const instance = new Map<ExternalName, VersionName>();
    for (const copy of own.get(owner)!) {
      for (const specifier of copy.specifiers)
        if (!tags.has(specifier)) tags.set(specifier, copy.tag);
      instance.set(copy.member, copy.tag);
    }
    return { owner, tags, instance };
  };

  // Which build is newer: the first member both ship, in pool order, whose tags differ decides, so two
  // unrelated version lines are never compared.
  const newer = (a: Variant, b: Variant): number => {
    for (const { name } of members) {
      const tagA = a.instance.get(name);
      const tagB = b.instance.get(name);
      if (tagA === undefined || tagB === undefined) continue;
      const d = compare(tagA, tagB);
      if (d !== 0) return d;
    }
    return 0;
  };

  // A specifier the variant does not ship is still pinned by its package's tag: a flat `core/testing` at
  // 22.0.6 next to a variant's `core` at 22.0.8 is two cores, whoever lists the entrypoint.
  const agrees = (remote: RemoteName, tags: SpecifierTags): boolean =>
    own.get(remote)!.every(copy =>
      copy.specifiers.every(s => {
        const tag = tags.tagOf(s);
        return tag === undefined || tag === copy.tag;
      })
    );

  // Same tag, same artefact: round 1 also serves entrypoints other copies of its tags ship — but only from
  // builds that agree with it, since a borrowed file binds its own imports where it lives.
  const withSameTagEntries = (variant: Variant): Variant => {
    const tags = new SpecifierTags(variant.tags);
    const loans = new Map<Specifier, RemoteName[]>();
    for (const [remote, copies] of own) {
      if (remote === variant.owner || !agrees(remote, variant.tags)) continue;
      for (const copy of copies)
        for (const specifier of copy.specifiers)
          if (!variant.tags.has(specifier) && variant.tags.tagOf(specifier) === copy.tag) {
            tags.set(specifier, copy.tag);
            loans.set(specifier, [...(loans.get(specifier) ?? []), remote]);
          }
    }
    return { ...variant, tags, loans };
  };

  const serves = (variant: Variant, remote: RemoteName): boolean =>
    own.get(remote)!.every(copy =>
      copy.specifiers.every(s => {
        const tag = variant.tags.get(s);
        return tag !== undefined && acceptsTag(tag, copy.tag, copy.requiredVersion);
      })
    );

  const builds = new Map<RemoteName, SpecifierTags>();
  const buildOf = (owner: RemoteName) => {
    let tags = builds.get(owner);
    if (!tags) builds.set(owner, (tags = variantOf(owner).tags));
    return tags;
  };
  // One build must have shipped the combination a remote resolves; a build witnesses its packages' other
  // entrypoints at its tag. See docs/version-resolver.md §"How pooling resolves".
  const shippedTogether = (specifiers: Specifier[]): boolean =>
    [...own.keys()].some(build =>
      specifiers.every(s => buildOf(build).tagOf(s) === coverage.get(s))
    );
  const witnessed = (remote: RemoteName) =>
    shippedTogether(own.get(remote)!.flatMap(c => c.specifiers));
  // The first specifier no build ships next to the ones before it, and a smallest set of those it clashes with.
  const unwitnessed = (remote: RemoteName) => {
    const specifiers = own.get(remote)!.flatMap(c => c.specifiers);
    const matches = [...own.keys()].map(build => {
      const tags = buildOf(build);
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

  const byArrival = (a: RemoteName, b: RemoteName) =>
    (arrival.get(a) ?? Number.MAX_SAFE_INTEGER) - (arrival.get(b) ?? Number.MAX_SAFE_INTEGER) ||
    compareStrings(a, b);
  const remotes = [...own.keys()].sort(byArrival);

  type Candidate = { variant: Variant; served: RemoteName[] };
  // Highest first on every key, then the newer build; the input is in arrival order and the sort is stable.
  const rank = (candidates: Candidate[], keys: ((c: Candidate) => number)[]) => {
    const scored = candidates.map(c => ({ c, k: keys.map(key => key(c)) }));
    scored.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const d = b.k[i]! - a.k[i]!;
        if (d !== 0) return d;
      }
      return newer(b.c.variant, a.c.variant);
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
    tagOf: s => coverage.tagOf(s),
    missOf: remote => {
      let rejected: { member: ExternalName; tag: VersionName; strict: boolean } | undefined;
      for (const copy of own.get(remote) ?? [])
        for (const s of copy.specifiers) {
          const tag = coverage.get(s);
          if (tag === undefined || acceptsTag(tag, copy.tag, copy.requiredVersion)) continue;
          if (copy.strict) return { rejected: { member: copy.member, tag, strict: true } };
          rejected ??= { member: copy.member, tag, strict: false };
        }
      if (rejected) return { rejected };
      for (const copy of own.get(remote) ?? [])
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
  const round1 = (host ? [host] : remotes).map(owner => {
    const variant = withSameTagEntries(variantOf(owner));
    return { variant, served: remotes.filter(r => serves(variant, r)) };
  });
  const newerThan = (c: Candidate) => round1.filter(o => newer(c.variant, o.variant) > 0).length;
  // Remotes that agree without being served still take this build's files (rule 5): when no build serves
  // more than itself, that is what separates a build its peers share from an outlier.
  const agreeing = (c: Candidate) => {
    const served = new Set(c.served);
    return remotes.filter(r => !served.has(r) && agrees(r, c.variant.tags)).length;
  };
  const first = rank(round1, [
    ...(input.latestFirst ? [newerThan] : []),
    c => c.served.length,
    agreeing,
    c => (c.variant.owner === input.previous ? 1 : 0),
  ])!;

  election.winner = first.variant.owner;
  for (const [s, tag] of first.variant.tags) coverage.set(s, tag);
  election.global = new Set([election.winner, ...first.served]);

  // A borrowed file is published only from a copy that resolves globally. Where no round-1 remote ships it,
  // its lenders must stay out of any subpool whose build disagrees, or nothing would publish it.
  const shipsAt = (remote: RemoteName, specifier: Specifier, tag: VersionName) =>
    own.get(remote)!.some(c => c.tag === tag && c.specifiers.includes(specifier));
  const lenders = new Set<RemoteName>();
  for (const [specifier, from] of first.variant.loans ?? [])
    if (![...election.global].some(r => shipsAt(r, specifier, coverage.get(specifier)!)))
      for (const remote of from) lenders.add(remote);

  // Later rounds form subpools: own builds only, among the remotes still waiting, while one serves at least
  // two.
  let pending = remotes.filter(r => !election.global.has(r));
  for (;;) {
    const candidates = pending
      .map(owner => {
        const variant = variantOf(owner);
        const keepsLoans = agrees(owner, coverage);
        const served = pending.filter(
          r => serves(variant, r) && (r === owner || keepsLoans || !lenders.has(r))
        );
        return { variant, served };
      })
      .filter(c => c.served.includes(c.variant.owner) && c.served.length >= 2);
    const best = rank(candidates, [c => c.served.length]);
    if (!best) break;
    election.subpools.push({ build: best.variant.owner, members: best.served });
    pending = pending.filter(r => !best.served.includes(r));
  }

  // A package round 1 does not ship at all is published from the builds that agree with it, when every one
  // of them ships it at one tag: agreeing, their files bind the elected versions, and one tag cannot split
  // it. Last, so it only moves remotes no later round could place in a subpool.
  // A subpool copy resolves globally only when its subpool's build agrees; otherwise it is never published.
  const subpoolOf = new Map(
    election.subpools.flatMap(p => p.members.map(r => [r, p.build] as const))
  );
  const contributors = remotes.filter(
    r => !election.global.has(r) && agrees(r, coverage) && agrees(subpoolOf.get(r) ?? r, coverage)
  );
  const extras = new Map<string, { tag: VersionName; specifiers: Specifier[] } | null>();
  for (const remote of contributors)
    for (const copy of own.get(remote)!)
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
  const extended: Variant = { ...first.variant, tags: coverage };
  const takesExtended = (remote: RemoteName) => serves(extended, remote) && witnessed(remote);
  for (const remote of pending) if (takesExtended(remote)) election.global.add(remote);
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

  election.alone = pending.filter(r => !election.global.has(r)).sort(byArrival);
  for (const remote of [...election.subpools.map(p => p.build), ...election.alone])
    if (agrees(remote, coverage)) election.agreeing.add(remote);

  return election;
}
