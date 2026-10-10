import type {
  ExternalName,
  ImportMap,
  RemoteName,
  SharedExternal,
  shareScope,
  VersionName,
} from 'lib/core/1.domain';
import * as _path from 'lib/utils/path';
import { owningPackage } from 'lib/core/1.domain/externals/specifier';

// Re-exported so harnesses outside `src` depend on `lib/testing` only, not on where the step code lives.
export { owningPackage };

type Specifier = string;

/** Per remote, the `(specifier → tag)` set its own build ships — the witness candidates. */
export type Builds = Map<RemoteName, Map<Specifier, VersionName>>;

export type Incoherence = {
  remote: RemoteName;
  /** What the map resolves for it, per specifier of the pool. */
  resolved: Record<Specifier, VersionName>;
  /** The build that came closest to witnessing it, for a legible failure message. */
  closest?: { build: RemoteName; matched: number; of: number };
};

export type CoherenceInput = {
  importMap: ImportMap;
  /** The pool's members as stored — what `sharedExternalsRepo.getFromScope` returns, filtered to the pool. */
  members: Record<ExternalName, SharedExternal>;
  scopeUrls: Record<RemoteName, string>;
  /** I3's only exemption: a host cannot be repointed onto another build, so it is never judged. */
  hosts?: RemoteName[];
};

/**
 * I3, the no-tear invariant, checked off the emitted import map rather than off the stored verdicts:
 * for every non-host remote, the `(specifier → tag)` combination it really resolves must be a subset of
 * some live build's own combination. Which remote *serves* a given tag is free — two builds at one tag
 * are interchangeable providers — so this compares tags only, never origins. A build that ships a package
 * at a tag also witnesses that package's other entrypoints at it: copies of one version merge their
 * entries (docs/version-resolver.md §"Merging within a version").
 *
 * Reads the map the way a browser would (a remote's own scope entry wins over `imports`), so it fails on
 * exactly the combinations a page would really run. Deliberately not called `findTears`:
 * `apply-winner.ts:110` owns that name for entrypoint coverage, which is a different failure.
 */
export function findIncoherentRemotes({
  importMap,
  members,
  scopeUrls,
  hosts = [],
}: CoherenceInput): Incoherence[] {
  const builds: Builds = new Map();
  // Every URL the record can emit, with the tag it carries, so a resolved URL can be read back as a tag.
  const tagOfUrl = new Map<string, VersionName>();

  for (const external of Object.values(members)) {
    // D28: a build ships one copy per member, so a second row of one remote is read as its first.
    const read = new Set<RemoteName>();
    for (const version of external.versions) {
      for (const meta of version.remotes) {
        const scopeUrl = scopeUrls[meta.name];
        if (scopeUrl === undefined) continue;

        let own = builds.get(meta.name);
        if (!own) builds.set(meta.name, (own = new Map()));
        const first = !read.has(meta.name);
        read.add(meta.name);

        for (const [specifier, file] of Object.entries(meta.entries)) {
          if (first) own.set(specifier, version.tag);
          tagOfUrl.set(_path.join(scopeUrl, file), version.tag);
        }
      }
    }
  }

  // A build ships each package at one tag, whichever of its entrypoints it lists: the root's tag, else the
  // first entrypoint's. So `pkg/sub@T` witnesses `pkg@T` and `pkg/other@T`, as `SpecifierTags` reads it.
  const packageTags = new Map<RemoteName, Map<Specifier, VersionName>>();
  for (const [build, ships] of builds) {
    const packages = new Map<Specifier, VersionName>();
    for (const [specifier, tag] of ships) {
      const pkg = owningPackage(specifier);
      if (pkg === undefined) packages.set(specifier, tag);
      else if (!packages.has(pkg)) packages.set(pkg, tag);
    }
    packageTags.set(build, packages);
  }

  const exempt = new Set(hosts);
  const incoherent: Incoherence[] = [];

  for (const [remote, consumes] of builds) {
    if (exempt.has(remote)) continue;

    const ownScope = importMap.scopes?.[scopeUrls[remote]!] ?? {};
    const resolved: Record<Specifier, VersionName> = {};

    for (const specifier of consumes.keys()) {
      const url = ownScope[specifier] ?? importMap.imports[specifier];
      // Not served anywhere: the member left the shared set entirely, which is a coverage outcome
      // rather than an incoherent pair, so it cannot be judged here.
      if (url === undefined) continue;
      // A file no member copy emits is outside the pool, so no build can witness it.
      resolved[specifier] = tagOfUrl.get(url) ?? '<untaggable>';
    }

    const entries = Object.entries(resolved);
    if (entries.length === 0) continue;

    let closest: Incoherence['closest'];
    let witnessed = false;

    for (const [build, ships] of builds) {
      const packages = packageTags.get(build)!;
      const matched = entries.filter(
        ([specifier, tag]) =>
          (ships.get(specifier) ?? packages.get(owningPackage(specifier) ?? specifier)) === tag
      ).length;
      if (matched === entries.length) {
        witnessed = true;
        break;
      }
      if (!closest || matched > closest.matched) {
        closest = { build, matched, of: entries.length };
      }
    }

    if (!witnessed) incoherent.push({ remote, resolved, closest });
  }

  return incoherent;
}

/** Every file the map can make a browser fetch — the static stand-in for the e2e download count. */
export function emittedUrls(importMap: ImportMap): Set<string> {
  const urls = new Set(Object.values(importMap.imports));
  for (const scope of Object.values(importMap.scopes ?? {})) {
    for (const url of Object.values(scope)) urls.add(url);
  }
  return urls;
}

export type Split = {
  remote: RemoteName;
  /** Specifiers the remote's import graph reaches at more than one tag, with every tag reached. */
  specifiers: Record<Specifier, VersionName[]>;
};

/**
 * The binding invariant, the second hop `findIncoherentRemotes` cannot see. A file's own imports resolve
 * from **where the file lives** (its owner's scope, else `imports`), not from the remote that loaded it, so
 * a remote resolving a coherent set directly can still run a second build one import in: a global
 * `material@22.0.6` bound to the global `core@22.0.8` inside a remote that runs `core@22.0.6` itself.
 *
 * Walks every file a remote reaches and requires one tag per specifier, and per package, across the whole
 * walk. Which peers a file really imports is unknown, so every specifier its owner ships counts as an edge:
 * conservative, never blind. Tags, never origins, as in I3, and a host is exempt for the same reason.
 *
 * Pass **one pool's** members. Across pools the walk finds couplings no pool declares — e.g. a private
 * library in its own pool binding the global framework inside a remote that runs its own — which pooling
 * leaves to the portfolio by design (docs/version-resolver.md §"Declare the coupling you actually have").
 */
export function findSplitRemotes({
  importMap,
  members,
  scopeUrls,
  hosts = [],
}: CoherenceInput): Split[] {
  const builds: Builds = new Map();
  const ownerOfUrl = new Map<string, RemoteName>();
  const tagOfUrl = new Map<string, VersionName>();

  for (const external of Object.values(members)) {
    for (const version of external.versions) {
      for (const meta of version.remotes) {
        const scopeUrl = scopeUrls[meta.name];
        if (scopeUrl === undefined) continue;

        let own = builds.get(meta.name);
        if (!own) builds.set(meta.name, (own = new Map()));
        for (const [specifier, file] of Object.entries(meta.entries)) {
          if (!own.has(specifier)) own.set(specifier, version.tag);
          const url = _path.join(scopeUrl, file);
          ownerOfUrl.set(url, meta.name);
          tagOfUrl.set(url, version.tag);
        }
      }
    }
  }

  const scopes = Object.keys(importMap.scopes ?? {}).sort((a, b) => b.length - a.length);
  const resolveFrom = (base: string, specifier: Specifier): string | undefined => {
    for (const prefix of scopes) {
      if (!base.startsWith(prefix)) continue;
      const hit = importMap.scopes![prefix]![specifier];
      if (hit !== undefined) return hit;
    }
    return importMap.imports[specifier];
  };

  const exempt = new Set(hosts);
  const split: Split[] = [];

  for (const [remote, consumes] of builds) {
    if (exempt.has(remote)) continue;

    const reached = new Map<Specifier, Set<VersionName>>();
    const seen = new Set<string>();
    const queue: [Specifier, string][] = [];
    const visit = (specifier: Specifier, url: string | undefined) => {
      const tag = url === undefined ? undefined : tagOfUrl.get(url);
      if (url === undefined || tag === undefined) return;
      let tags = reached.get(specifier);
      if (!tags) reached.set(specifier, (tags = new Set()));
      tags.add(tag);
      if (!seen.has(url)) {
        seen.add(url);
        queue.push([specifier, url]);
      }
    };

    for (const specifier of consumes.keys())
      visit(specifier, resolveFrom(scopeUrls[remote]!, specifier));
    while (queue.length > 0) {
      const [, url] = queue.shift()!;
      for (const specifier of builds.get(ownerOfUrl.get(url)!)!.keys())
        visit(specifier, resolveFrom(url, specifier));
    }

    // A package is one version, so two of its entrypoints at different tags are two builds of it even
    // though each specifier alone reaches one tag (`material/sort@17.0.2` beside `material/table@17.0.0`).
    // Reported under the package name.
    const packages = new Map<Specifier, Set<VersionName>>();
    for (const [specifier, tags] of reached) {
      const pkg = owningPackage(specifier);
      if (pkg === undefined) continue;
      let all = packages.get(pkg);
      if (!all) packages.set(pkg, (all = new Set(reached.get(pkg))));
      for (const tag of tags) all.add(tag);
    }

    const torn = [...reached, ...packages].filter(([, tags]) => tags.size > 1);
    if (torn.length > 0)
      split.push({
        remote,
        specifiers: Object.fromEntries(torn.map(([s, t]) => [s, [...t].sort()])),
      });
  }

  return split;
}

/** One torn group: a stored pool (`<scope>|<poolName>`) or an unpooled npm package (`<scope>|package:<pkg>`). */
export type GroupTear = { pool: string; incoherent: Incoherence[]; split: Split[] };

export type TearsInput = {
  importMap: ImportMap;
  /** The stored record per share scope, as `SharedExternals` holds it. */
  externals: Record<string, shareScope>;
  scopeUrls: Record<RemoteName, string>;
  hosts?: RemoteName[];
};

/**
 * Both oracles, run the way they must be: one group at a time. A group is a stored pool, by `poolName`;
 * outside any pool, an npm package is still one version, so its entrypoints (separate flat externals or
 * not) are judged together. Across groups the walk would find couplings no pool declares, which pooling
 * leaves to the portfolio by design. Only torn groups are listed: `[]` is a coherent page.
 */
export function tearsByPool({
  importMap,
  externals,
  scopeUrls,
  hosts = [],
}: TearsInput): GroupTear[] {
  const groups = new Map<string, Record<ExternalName, SharedExternal>>();
  for (const [scope, record] of Object.entries(externals))
    for (const [name, external] of Object.entries(record)) {
      const group =
        external.poolName !== undefined
          ? `${scope}|${external.poolName}`
          : `${scope}|package:${owningPackage(name) ?? name}`;
      groups.set(group, { ...groups.get(group), [name]: external });
    }

  const tears: GroupTear[] = [];
  for (const [pool, members] of groups) {
    const input = { importMap, members, scopeUrls, hosts };
    const tear = { pool, incoherent: findIncoherentRemotes(input), split: findSplitRemotes(input) };
    if (tear.incoherent.length > 0 || tear.split.length > 0) tears.push(tear);
  }
  return tears;
}
