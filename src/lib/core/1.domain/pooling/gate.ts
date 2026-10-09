import {
  type ExternalName,
  GLOBAL_SCOPE,
  type PoolCause,
  type RemoteName,
  type SharedExternal,
  type SharedInfoActions,
  type SharedVersion,
  type SharedVersionMeta,
  type VersionName,
} from 'lib/core/1.domain';
import { addRemoteToVersion, forEachVersionEntry } from 'lib/core/1.domain/externals/basis';
import type { AcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { byTag, rowAt } from 'lib/core/1.domain/externals/rows';
import { type Specifier, SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import * as _path from 'lib/utils/path';
import { type Build, buildOf, type Copy } from './builds';
import type { PoolMember } from './membership';
import { agrees, shippedTogether } from './rules';

// The dynamic gate: a remote loaded at runtime resolves through the committed global map or serves its whole
// pool family itself. See docs/version-resolver.md §"Scope and dynamic init".

export type CommittedView = {
  builds: Map<RemoteName, Build>;
  // What the committed `imports` serves, per specifier.
  global: Map<Specifier, { tag: VersionName; remote: RemoteName; file: string }>;
};

// Why the loaded remote cannot resolve through the committed map; the step words it.
export type GateMiss =
  | { cause: 'incompatible'; specifier: Specifier; tag: VersionName }
  | { cause: 'uncovered'; specifier: Specifier }
  | { cause: 'uncovered'; scoped: ExternalName }
  | { cause: 'uncovered'; unshipped: true };

// A member whose action the map now serves: `skip` turns its share into a skip.
export type MapCover = {
  name: ExternalName;
  skip: boolean;
  covered: Specifier[];
  override: Record<Specifier, string>;
};

// How the loaded remote's copy of one member moves in the record.
export type CopyMove = { cause: PoolCause } | { fromMap: true };

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

// The init rules against a map that can no longer change (§"Scope and dynamic init", step 2). A member the
// resolver scoped means the map cannot serve it, so no committed build is trusted with this remote.
export function judgeRemote(
  own: readonly Copy[],
  view: CommittedView,
  scoped: ReadonlySet<ExternalName>,
  accepts: AcceptsTag
): 'global' | GateMiss {
  const { rejected, missing } = scan(own, view, accepts);
  if (rejected) return { cause: 'incompatible', ...rejected };
  const [resolverScoped] = scoped;
  if (resolverScoped === undefined) {
    const globalTags = new SpecifierTags([...view.global].map(([s, { tag }]) => [s, tag] as const));
    // The map's tags must be a combination one build shipped: agreeing is its own witness, otherwise one
    // committed build must be.
    if (agrees(own, globalTags)) return 'global';
    if (missing === undefined && shippedTogether(own, globalTags, view.builds.values()))
      return 'global';
  }
  if (missing !== undefined) return { cause: 'uncovered', specifier: missing };
  return resolverScoped === undefined
    ? { cause: 'uncovered', unshipped: true }
    : { cause: 'uncovered', scoped: resolverScoped };
}

// `covered` is per external, but the map serves by specifier: an entrypoint another member ships as a package
// of its own (flat vs dense) is served all the same. A named scope has no `imports` to inherit, so the remote's
// own scope names the committed source's file for each specifier, over the resolver's (one row's copy).
export function coverFromMap(
  remote: RemoteName,
  mine: readonly PoolMember[],
  view: CommittedView,
  actions: Readonly<SharedInfoActions>,
  map: {
    shareScope: string;
    selfFill: boolean;
    scopeUrlOf: (remote: RemoteName) => string | undefined;
  }
): { covers: MapCover[] } | { unmapped: RemoteName } {
  const covers: MapCover[] = [];

  for (const member of mine) {
    const action = actions[member.name]!;
    if (action.action === 'scope') continue;
    // Inherits every mapping already.
    if (action.action === 'skip' && !action.covered) continue;
    const own = member.external.versions.flatMap(v => v.remotes).find(r => r.name === remote);
    if (!own) continue;

    const covered = new Set(action.covered);
    const override = { ...action.override };
    for (const specifier in own.entries) {
      const source = view.global.get(specifier);
      if (!source) continue;
      if (map.shareScope !== GLOBAL_SCOPE) {
        const scopeUrl = map.scopeUrlOf(source.remote);
        if (!scopeUrl) return { unmapped: source.remote };
        override[specifier] = _path.join(scopeUrl, source.file);
      }
      covered.add(specifier);
    }

    const skip = action.action === 'share';
    const partial = covered.size < Object.keys(own.entries).length;
    if (skip && (covered.size === 0 || (partial && !map.selfFill))) continue;
    covers.push({ name: member.name, skip, covered: [...covered], override });
  }

  return { covers };
}

// A fresh record with only the loaded remote's copy moved: into a `scope` row at its tag, or into a skip row
// that runs the map's files.
export function recordMove(
  external: SharedExternal,
  remote: RemoteName,
  move: CopyMove,
  compare: (a: VersionName, b: VersionName) => number
): SharedExternal {
  if ('fromMap' in move) return recordFromMap(external, remote);

  const moved: { tag: string; meta: SharedVersionMeta }[] = [];
  const versions = external.versions
    .map(v => {
      const own = v.remotes.find(r => r.name === remote);
      if (!own) return v;
      const { servedBy: _servedBy, ...rest } = own;
      const meta = { ...rest, cached: true, poolCause: move.cause };
      if (v.action === 'scope')
        return { ...v, remotes: v.remotes.map(r => (r === own ? meta : r)) };
      moved.push({ tag: v.tag, meta });
      return { ...v, remotes: v.remotes.filter(r => r !== own) };
    })
    // A version only the loaded remote held — a `share` it introduced — leaves with it.
    .filter(v => v.remotes.length > 0);

  for (const { tag, meta } of moved) {
    const scoped = rowAt(versions, tag, 'scope');
    if (!scoped) versions.push({ tag, action: 'scope', host: false, remotes: [meta] });
    else versions[versions.indexOf(scoped)] = { ...scoped, remotes: [...scoped.remotes, meta] };
  }

  return { ...external, versions: versions.sort(byTag(compare)) };
}

// The remote's copies against the committed global map: the first tag a range rejects and the first
// entrypoint the map does not serve.
function scan(own: readonly Copy[], view: CommittedView, accepts: AcceptsTag) {
  let rejected: { specifier: Specifier; tag: VersionName } | undefined;
  let missing: Specifier | undefined;
  for (const copy of own)
    for (const s of copy.specifiers) {
      const global = view.global.get(s);
      if (global === undefined) missing ??= s;
      else if (!accepts(global.tag, copy.tag, copy.requiredVersion))
        rejected ??= { specifier: s, tag: global.tag };
    }
  return { rejected, missing };
}

// The share row `update-cache` opened for a copy that now runs the map's files becomes a skip: it
// publishes nothing. A tag keeps one row per action, so the copy joins a skip row already there.
function recordFromMap(external: SharedExternal, remote: RemoteName): SharedExternal {
  // Only a member whose action was `share` gets this move, so its copy sits in a share row.
  const opened = external.versions.find(
    v => v.action === 'share' && v.remotes.some(r => r.name === remote)
  )!;
  const meta = { ...opened.remotes.find(r => r.name === remote)!, cached: false };
  const joined = rowAt(external.versions, opened.tag, 'skip');

  if (!joined) {
    return {
      ...external,
      versions: external.versions.map(v =>
        v === opened
          ? { ...v, action: 'skip', remotes: v.remotes.map(r => (r.name === remote ? meta : r)) }
          : v
      ),
    };
  }

  const into = { ...joined, remotes: [...joined.remotes] };
  addRemoteToVersion(into, meta);
  return {
    ...external,
    versions: external.versions.filter(v => v !== opened).map(v => (v === joined ? into : v)),
  };
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
    const shareRow = member.external.versions.find(
      v => v.action === 'share' && v.remotes.some(r => r.name !== without)
    );
    if (shareRow) claim(shareRow);
  }
  for (const member of walk)
    for (const version of member.external.versions) if (version.action === 'skip') claim(version);
}
