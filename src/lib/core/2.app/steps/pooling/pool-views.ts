import type { ExternalName, RemoteName, SharedVersion, VersionName } from 'lib/core/1.domain';
import type {
  BuildView,
  CommittedView,
  Islanded,
  PoolMember,
  Specifier,
} from './pool.types';

/**
 * Read-only projections of one pool's stored record: everything the gates in `anchoring.ts` decide on is
 * derived here, and nothing here decides anything.
 *
 * Every set is keyed by entrypoint **specifier**, not by external name. A flat remote declares
 * `@framework/core/testing` as its own external while a dense one carries the same specifier as an entry
 * of `@framework/core`; comparing names makes those two shapes mutually uncoverable for a build-tool
 * reason with no provenance content. See docs/version-resolver.md §"How pooling resolves".
 */

type VersionMeta = SharedVersion['remotes'][number];

/**
 * Per build: the specifiers it serves and from which file, the tag each is served at, and the
 * `(member → tag)` instance it runs. Built once per pool and reused across consumers, so a coverage question
 * is a subset test rather than a walk of `entries`.
 *
 * A `scope` copy is excluded — it is about to self-serve, so it serves nobody else.
 */
export function liveBuilds(members: PoolMember[], islanded?: Islanded): Map<RemoteName, BuildView> {
  return walkBuilds(members, islanded, true);
}

/**
 * The same walk over the *committed* record, where a `scope` copy is a **stable island** rather than a
 * remote about to self-serve: its files are already in the map under its own scope and it demonstrably runs
 * its own build, so it can serve a remote loaded later.
 */
export function committedView(members: PoolMember[]): CommittedView {
  const global: CommittedView['global'] = new Map();

  // Mirrors what `generate-import-map` emitted, so `global` is what the committed map really serves.
  forEachGlobalClaim(members, undefined, (specifier, tag, meta) => {
    if (!global.has(specifier))
      global.set(specifier, { tag, remote: meta.name, file: meta.entries[specifier]! });
  });

  return { builds: walkBuilds(members, undefined, false), global };
}

function walkBuilds(
  members: PoolMember[],
  islanded: Islanded | undefined,
  skipScoped: boolean
): Map<RemoteName, BuildView> {
  const builds = new Map<RemoteName, BuildView>();

  for (const member of members) {
    const versions = member.external.versions;
    for (let v = 0; v < versions.length; v++) {
      const version = versions[v]!;
      if (skipScoped && version.action === 'scope') continue;

      const remotes = version.remotes;
      for (let r = 0; r < remotes.length; r++) {
        const meta = remotes[r]!;
        if (islanded?.has(meta.name)) continue;

        let own = builds.get(meta.name);
        if (!own) {
          builds.set(
            meta.name,
            (own = { coverage: new Map(), tags: new Map(), instance: new Map() })
          );
        }

        // A remote ships one copy per member, so a second row is a record it cannot produce; first tag
        // wins so such a record still reads deterministically.
        if (!own.instance.has(member.name)) own.instance.set(member.name, version.tag);
        for (const specifier in meta.entries) {
          own.coverage.set(specifier, meta.entries[specifier]!);
          if (!own.tags.has(specifier)) own.tags.set(specifier, version.tag);
        }
      }
    }
  }

  return builds;
}

/**
 * Per remote, the tag it ships each member at — **including** copies marked `scope`, which is what
 * separates this from `liveBuilds`. That one answers "what can this build serve others"; this one answers
 * "what does this remote run itself", where a `scope` copy is precisely what it runs. Only the second
 * question can see a torn family.
 */
export function ownTagsPerRemote(
  members: PoolMember[],
  // Callers that only judge a few remotes pay for a few: the whole pool is never needed at once.
  only?: ReadonlySet<RemoteName>
): Map<RemoteName, Map<ExternalName, VersionName>> {
  const own = new Map<RemoteName, Map<ExternalName, VersionName>>();

  for (const member of members) {
    for (const version of member.external.versions) {
      for (const meta of version.remotes) {
        if (only && !only.has(meta.name)) continue;

        let tags = own.get(meta.name);
        if (!tags) own.set(meta.name, (tags = new Map()));
        if (!tags.has(member.name)) tags.set(member.name, version.tag);
      }
    }
  }

  return own;
}

// Per remote, what it must be served. Wider than its instance: a copy marked `scope` is excluded there
// but still consumed.
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

/** `consumedMembers` in specifier space. */
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

/**
 * The build serving each member, i.e. `remotes[0]` of its shared version — skipping copies islanding has
 * taken, since those are about to self-serve. A member with no entry is served by nobody and every
 * consumer falls back to its own build.
 */
export function servingBuilds(
  members: PoolMember[],
  islanded: Islanded
): Map<ExternalName, RemoteName> {
  const serving = new Map<ExternalName, RemoteName>();

  for (const member of members) {
    const shared = member.external.versions.find(v => v.action === 'share');
    const basis = shared?.remotes.find(r => !islanded.has(r.name));
    if (basis) serving.set(member.name, basis.name);
  }

  return serving;
}

/**
 * The copy whose file the global mapping publishes, per member: the first copy of the member's `share`
 * version that still runs its own build. A remote deduping onto a foreign build is skipped, because
 * publishing its file while it runs somebody else's makes the global mapping and `servedBy` name two
 * different builds for one remote (constraint 17). Order is otherwise the basis precedence `commit()`
 * established, so skipping never promotes a worse-covered copy over a better one. A member with no entry has
 * no basis left and leaves the shared set.
 */
export function basisPerMember(
  members: PoolMember[],
  islanded?: Islanded,
  dedupsElsewhere?: (remote: RemoteName) => boolean
): Map<ExternalName, RemoteName> {
  const basis = new Map<ExternalName, RemoteName>();

  for (const member of members) {
    const winner = member.external.versions.find(v => v.action === 'share');
    if (!winner) continue;
    const own = winner.remotes.find(
      r => !islanded?.has(r.name) && !dedupsElsewhere?.(r.name)
    );
    if (own) basis.set(member.name, own.name);
  }

  return basis;
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

/**
 * The tag the global `imports` publishes per specifier. Reading the winning version's basis alone
 * understates it, which islands remotes that were never at risk.
 */
export function sharedTagPerSpecifier(
  members: PoolMember[],
  islanded: Islanded
): Map<Specifier, VersionName> {
  const shared = new Map<Specifier, VersionName>();
  forEachGlobalClaim(members, islanded, (specifier, tag) => {
    if (!shared.has(specifier)) shared.set(specifier, tag);
  });
  return shared;
}

/**
 * The order `generate-import-map` fills the global `imports` in, and the single place it is encoded on this
 * side: per member the `share` version's basis first, then its siblings, then the `skip` copies, each filling
 * only what nobody claimed yet (`selfFillUncovered`). Both gates decide on what a consumer would *land on*,
 * so both read this rather than the winning version alone — a package's secondary entrypoints are routinely
 * published from a sibling copy of the same tag.
 *
 * `visit` is called in claim order for every candidate; first claim per specifier wins, which the callers
 * apply themselves so the walk stays allocation-free.
 */
function forEachGlobalClaim(
  members: PoolMember[],
  islanded: Islanded | undefined,
  visit: (specifier: Specifier, tag: VersionName, meta: VersionMeta) => void
): void {
  const claim = (version: SharedVersion) => {
    const remotes = version.remotes;
    for (let r = 0; r < remotes.length; r++) {
      const meta = remotes[r]!;
      if (islanded?.has(meta.name)) continue;
      for (const specifier in meta.entries) visit(specifier, version.tag, meta);
    }
  };

  for (const member of members) {
    const versions = member.external.versions;
    const winner = versions.find(v => v.action === 'share');
    if (winner) claim(winner);
    for (let v = 0; v < versions.length; v++) {
      if (versions[v]!.action === 'skip') claim(versions[v]!);
    }
  }
}
