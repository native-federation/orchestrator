import type {
  ExternalName,
  RemoteName,
  SharedVersion,
  SharedVersionMeta,
  VersionName,
} from 'lib/core/1.domain';
import { forEachVersionEntry } from 'lib/core/1.domain/externals/basis';
import type { Specifier } from 'lib/core/1.domain/externals/specifier';
import { type Build, buildOf, type Copy } from './builds';
import type { PoolMember } from './membership';

// Read-only projections of one pool's stored record, keyed by specifier rather than external name so flat and
// dense builds of one package compare; see docs/version-resolver.md §"How pooling resolves".

export type CommittedView = {
  builds: Map<RemoteName, Build>;
  // What the committed `imports` serves, per specifier.
  global: Map<Specifier, { tag: VersionName; remote: RemoteName; file: string }>;
};

// A `scope` copy counts as served by its build: its files are already in the map under its own scope.
// `without` is left out: `update-cache` has already stored a loaded remote's copies, but the committed map holds
// none of them.
export function committedView(
  members: PoolMember[],
  shipped: ReadonlyMap<RemoteName, readonly Copy[]>,
  recordOrder: ExternalName[],
  without?: RemoteName
): CommittedView {
  const global: CommittedView['global'] = new Map();

  // Mirrors what `generate-import-map` emitted, so `global` is what the committed map really serves.
  forEachGlobalClaim(members, recordOrder, without, (specifier, tag, meta) => {
    if (!global.has(specifier))
      global.set(specifier, { tag, remote: meta.name, file: meta.entries[specifier]! });
  });

  const builds = new Map<RemoteName, Build>();
  for (const [owner, copies] of shipped)
    if (owner !== without) builds.set(owner, buildOf(owner, copies));

  return { builds, global };
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
  recordOrder: ExternalName[],
  without: RemoteName | undefined,
  visit: (specifier: Specifier, tag: VersionName, meta: SharedVersionMeta) => void
): void {
  // generate-import-map's `imports` and `claimsOf` walks claim in the record's order.
  const rank = new Map(recordOrder.map((name, i) => [name, i]));
  const walk = [...members].sort((a, b) => rank.get(a.name)! - rank.get(b.name)!);

  const claim = (version: SharedVersion) =>
    forEachVersionEntry(
      version,
      meta => meta.name !== without,
      (specifier, meta) => visit(specifier, version.tag, meta)
    );

  for (const member of walk) {
    // A share row only `without` holds publishes nothing yet.
    const winner = member.external.versions.find(
      v => v.action === 'share' && v.remotes.some(r => r.name !== without)
    );
    if (winner) claim(winner);
  }
  for (const member of walk)
    for (const version of member.external.versions) if (version.action === 'skip') claim(version);
}
