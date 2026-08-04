import type {
  ExternalName,
  ImportMap,
  RemoteName,
  SharedExternal,
  VersionName,
} from 'lib/core/1.domain';
import * as _path from 'lib/utils/path';

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
 * are interchangeable providers — so this compares tags only, never origins.
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
    for (const version of external.versions) {
      for (const meta of version.remotes) {
        const scopeUrl = scopeUrls[meta.name];
        if (scopeUrl === undefined) continue;

        let own = builds.get(meta.name);
        if (!own) builds.set(meta.name, (own = new Map()));

        for (const [specifier, file] of Object.entries(meta.entries)) {
          own.set(specifier, version.tag);
          tagOfUrl.set(_path.join(scopeUrl, file), version.tag);
        }
      }
    }
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
      const tag = tagOfUrl.get(url);
      if (tag !== undefined) resolved[specifier] = tag;
    }

    const entries = Object.entries(resolved);
    if (entries.length === 0) continue;

    let closest: Incoherence['closest'];
    let witnessed = false;

    for (const [build, ships] of builds) {
      const matched = entries.filter(([specifier, tag]) => ships.get(specifier) === tag).length;
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
