import type {
  ExternalName,
  RemoteName,
  SharedVersion,
  SharedVersionMeta,
  VersionName,
} from 'lib/core/1.domain';
import { forEachVersionEntry } from 'lib/core/1.domain/externals/basis';
import { type Specifier, SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import type { PoolMember } from './membership';

// Read-only projections of one pool's stored record, keyed by specifier rather than external name so flat and
// dense builds of one package compare; see docs/version-resolver.md §"How pooling resolves".

// One remote's whole build of a pool: the unit of decision, as a build is consistent by construction.
export type FamilyInstance = Map<ExternalName, VersionName>;

// Specifier -> the file a build serves it from.
export type Coverage = Map<Specifier, string>;

export type BuildView = {
  coverage: Coverage;
  tags: SpecifierTags;
  instance: FamilyInstance;
};

export type CommittedView = {
  builds: Map<RemoteName, BuildView>;
  // What the committed `imports` serves, per specifier.
  global: Map<Specifier, { tag: VersionName; remote: RemoteName; file: string }>;
};

// A `scope` copy counts as served by its build: its files are already in the map under its own scope.
export function committedView(members: PoolMember[]): CommittedView {
  const global: CommittedView['global'] = new Map();

  // Mirrors what `generate-import-map` emitted, so `global` is what the committed map really serves.
  forEachGlobalClaim(members, (specifier, tag, meta) => {
    if (!global.has(specifier))
      global.set(specifier, { tag, remote: meta.name, file: meta.entries[specifier]! });
  });

  return { builds: walkBuilds(members), global };
}

function walkBuilds(members: PoolMember[]): Map<RemoteName, BuildView> {
  const builds = new Map<RemoteName, BuildView>();

  for (const member of members) {
    const versions = member.external.versions;
    for (let v = 0; v < versions.length; v++) {
      const version = versions[v]!;

      const remotes = version.remotes;
      for (let r = 0; r < remotes.length; r++) {
        const meta = remotes[r]!;
        let own = builds.get(meta.name);
        if (!own) {
          builds.set(
            meta.name,
            (own = { coverage: new Map(), tags: new SpecifierTags(), instance: new Map() })
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

// `consumedMembers` in specifier space.
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

// The first own-build copy of each member's `share` version, in `commit()`'s basis order: the one whose file
// the global mapping publishes. A member with no entry is not published globally.
export function basisPerMember(members: PoolMember[]): Map<ExternalName, RemoteName> {
  const basis = new Map<ExternalName, RemoteName>();

  for (const member of members) {
    const winner = member.external.versions.find(v => v.action === 'share');
    const own = winner?.remotes.find(r => r.servedBy === undefined);
    if (own) basis.set(member.name, own.name);
  }

  return basis;
}

// Basis precedence puts the host's own copy first on a `host: true` version, so its `remotes[0]` is the host.
export function hostRemotes(members: PoolMember[]): Set<RemoteName> {
  const hosts = new Set<RemoteName>();

  for (const member of members) {
    for (const version of member.external.versions) {
      if (version.host && version.remotes.length > 0) hosts.add(version.remotes[0]!.name);
    }
  }

  return hosts;
}

// The arrival order round 1 breaks ties by.
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

// The order `generate-import-map` fills `imports` in: every `share` version, then every `skip` copy; the
// caller keeps the first claim per specifier. `forEachVersionEntry` decides which copies may claim, so a copy
// served by another build never publishes.
function forEachGlobalClaim(
  members: PoolMember[],
  visit: (specifier: Specifier, tag: VersionName, meta: SharedVersionMeta) => void
): void {
  const claim = (version: SharedVersion) =>
    forEachVersionEntry(version, undefined, (specifier, meta) =>
      visit(specifier, version.tag, meta)
    );

  for (const member of members) {
    const winner = member.external.versions.find(v => v.action === 'share');
    if (winner) claim(winner);
  }
  for (const member of members)
    for (const version of member.external.versions) if (version.action === 'skip') claim(version);
}
