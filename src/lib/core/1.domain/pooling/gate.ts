import type { DeepReadonly } from 'lib/utils/deep-readonly';
import {
  type ExternalName,
  GLOBAL_SCOPE,
  type RemoteName,
  type SharedInfoActions,
  type SharedVersion,
  type SharedVersionMeta,
  type VersionName,
} from 'lib/core/1.domain';
import { forEachVersionEntry } from 'lib/core/1.domain/externals/basis';
import type { AcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { type Specifier, SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import * as _path from 'lib/utils/path';
import { type Build, buildOf, type Copy } from './builds';
import type { PoolMember } from './membership';
import { agrees, unwitnessedGap } from './rules';

// See docs/version-resolver.md §"Scope and dynamic init".

type CommittedView = {
  builds: Map<RemoteName, Build>;
  // What the committed global map serves per specifier: `imports`, or the shareScope's scopes.
  global: Map<Specifier, { tag: VersionName; remote: RemoteName; file: string }>;
  // Per build, the specifiers it runs from its own or a subpool's files, at the tag it runs.
  runsOffMap: Map<RemoteName, Map<Specifier, VersionName>>;
};

export type GateMiss =
  | { cause: 'incompatible'; specifier: Specifier; tag: VersionName }
  | { cause: 'uncovered'; specifier: Specifier }
  | { cause: 'uncovered'; unshipped: true }
  | { cause: 'uncovered'; owner: RemoteName; specifier: Specifier; tag: VersionName };

// `toSkip`: the copy moves out of a share row (opened or joined) or a resolver scope into a skip row.
type MapCover = {
  name: ExternalName;
  toSkip: boolean;
  covered: Specifier[];
  override: Record<Specifier, string>;
};

type MapPolicy = {
  shareScope: string;
  selfFill: boolean;
  scopeUrlOf: (remote: RemoteName) => string | undefined;
};

// A `scope` copy counts as served by its build: its files are already in the map under its own scope.
// `without` is left out: `update-cache` has already stored a loaded remote's copies, but the committed map holds
// none of them.
export function committedView(
  members: PoolMember[],
  shipped: ReadonlyMap<RemoteName, readonly Copy[]>,
  recordOrder: ExternalName[],
  { shareScope, without }: { shareScope: string; without?: RemoteName }
): CommittedView {
  const global: CommittedView['global'] = new Map();

  // `imports` holds only the copies marked cached; a named scope's override may name any copy.
  const publishes = (meta: SharedVersionMeta) =>
    meta.name !== without && (shareScope !== GLOBAL_SCOPE || meta.cached);
  // Mirrors what `generate-import-map` emitted, so `global` is what the committed map really serves.
  forEachGlobalClaim(members, recordOrder, without, publishes, (specifier, tag, meta) => {
    if (!global.has(specifier))
      global.set(specifier, { tag, remote: meta.name, file: meta.entries[specifier]! });
  });

  const builds = new Map<RemoteName, Build>();
  for (const [owner, copies] of shipped)
    if (owner !== without) builds.set(owner, buildOf(owner, copies));

  const runsOffMap: CommittedView['runsOffMap'] = new Map();
  for (const member of members)
    for (const version of member.external.versions)
      for (const meta of version.remotes) {
        if (version.action !== 'scope' && !meta.servedBy) continue;
        let runs = runsOffMap.get(meta.name);
        if (!runs) runsOffMap.set(meta.name, (runs = new Map()));
        // A subpool member's copy keeps its own tag in the record but runs its build's files.
        for (const specifier in meta.entries)
          runs.set(
            specifier,
            (meta.servedBy ? builds.get(meta.servedBy)?.tags.pinnedTag(specifier) : undefined) ??
              version.tag
          );
      }

  return { builds, global, runsOffMap };
}

// See docs/version-resolver.md §"Scope and dynamic init", step 1. A resolver scope needs no rule of its own:
// a range that rejects the map's tag is a miss here too.
export function judgeRemote(
  copies: readonly Copy[],
  view: CommittedView,
  accepts: AcceptsTag
): 'global' | GateMiss {
  const { rejected, missing } = scan(copies, view, accepts);
  if (rejected) return { cause: 'incompatible', ...rejected };
  const globalTags = new SpecifierTags([...view.global].map(([s, { tag }]) => [s, tag] as const));
  const binding = offMapBinding(copies, view, globalTags);
  if (binding) return { cause: 'uncovered', ...binding };
  // The map's tags must be a combination one build shipped: agreeing is its own witness, otherwise one
  // committed build must be.
  if (agrees(copies, globalTags)) return 'global';
  if (missing !== undefined) return { cause: 'uncovered', specifier: missing };
  if (unwitnessedGap(copies, globalTags, view.builds.values()) === undefined) return 'global';
  return { cause: 'uncovered', unshipped: true };
}

// `covered` is per external, but the map serves by specifier: an entrypoint another member ships as a package
// of its own (flat vs dense) is served all the same. A named scope has no `imports` to inherit, so the remote's
// own scope maps each such specifier to the file the committed map serves it from, replacing the resolver's
// override.
export function coverFromMap(
  remote: RemoteName,
  mine: readonly PoolMember[],
  view: CommittedView,
  actions: Readonly<SharedInfoActions>,
  policy: MapPolicy
): { covers: MapCover[] } | { unmapped: RemoteName } {
  const covers: MapCover[] = [];

  for (const member of mine) {
    const action = actions[member.name]!;
    // Inherits every mapping already.
    if (action.action === 'skip' && !action.covered) continue;
    const copy = member.external.versions.flatMap(v => v.remotes).find(r => r.name === remote);
    if (!copy) continue;

    const files = mapFiles(copy, view, policy, action);
    if ('unmapped' in files) return files;
    const { covered, override } = files;

    const opened = action.action !== 'skip';
    const partial = covered.size < Object.keys(copy.entries).length;
    if (opened && (covered.size === 0 || (partial && !policy.selfFill))) continue;
    // A copy that joined a share row would claim, on the next page, what the map serves from another member.
    const toSkip =
      opened ||
      (covered.size > action.covered!.length &&
        member.external.versions.some(v => v.action === 'share' && v.remotes.includes(copy)));
    covers.push({ name: member.name, toSkip, covered: [...covered], override });
  }

  return { covers };
}

function mapFiles(
  copy: SharedVersionMeta,
  view: CommittedView,
  policy: MapPolicy,
  action: SharedInfoActions[string]
): { covered: Set<Specifier>; override: Record<Specifier, string> } | { unmapped: RemoteName } {
  const covered = new Set(action.covered);
  const override = { ...action.override };
  for (const specifier in copy.entries) {
    const source = view.global.get(specifier);
    if (!source) continue;
    if (policy.shareScope !== GLOBAL_SCOPE) {
      const scopeUrl = policy.scopeUrlOf(source.remote);
      if (!scopeUrl) return { unmapped: source.remote };
      override[specifier] = _path.join(scopeUrl, source.file);
    }
    covered.add(specifier);
  }
  return { covered, override };
}

function scan(copies: readonly Copy[], view: CommittedView, accepts: AcceptsTag) {
  let rejected: { specifier: Specifier; tag: VersionName } | undefined;
  let missing: Specifier | undefined;
  for (const copy of copies)
    for (const s of copy.specifiers) {
      const global = view.global.get(s);
      if (global === undefined) missing ??= s;
      else if (!accepts(global.tag, copy.tag, copy.requiredVersion))
        rejected ??= { specifier: s, tag: global.tag };
    }
  return { rejected, missing };
}

// A committed file binds its pool-mates where its build runs them, so a build serving the remote that runs one
// off the map at another tag than the remote reaches elsewhere would split it. That tag is the map's, else the
// remote's own, else the first serving build's.
function offMapBinding(copies: readonly Copy[], view: CommittedView, globalTags: SpecifierTags) {
  const own = new SpecifierTags(copies.flatMap(c => c.specifiers.map(s => [s, c.tag] as const)));
  const servers = new Set<RemoteName>();
  for (const copy of copies)
    for (const specifier of copy.specifiers) {
      const build = view.global.get(specifier)?.remote;
      if (build !== undefined) servers.add(build);
    }

  const firstRun = new SpecifierTags();
  for (const build of servers)
    for (const [specifier, tag] of view.runsOffMap.get(build) ?? []) {
      const reached =
        globalTags.pinnedTag(specifier) ??
        own.pinnedTag(specifier) ??
        firstRun.pinnedTag(specifier);
      if (reached === undefined) firstRun.set(specifier, tag);
      else if (reached !== tag) return { owner: build, specifier, tag };
    }
  return undefined;
}

// The order `generate-import-map` fills `imports` in: every `share` version, then every `skip` copy; the
// caller keeps the first claim per specifier. Only a copy `publishes` accepts may claim, and
// `forEachVersionEntry` keeps out a copy served by another build.
function forEachGlobalClaim(
  members: PoolMember[],
  recordOrder: ExternalName[],
  without: RemoteName | undefined,
  publishes: (meta: SharedVersionMeta) => boolean,
  visit: (specifier: Specifier, tag: VersionName, meta: SharedVersionMeta) => void
): void {
  // The record's order: generate-import-map claims `imports` and named scopes (`claimsOf`) in it.
  const rank = new Map(recordOrder.map((name, i) => [name, i]));
  const walk = [...members].sort((a, b) => rank.get(a.name)! - rank.get(b.name)!);

  const claim = (version: DeepReadonly<SharedVersion>) =>
    forEachVersionEntry(version, publishes, (specifier, meta) =>
      visit(specifier, version.tag, meta)
    );

  for (const member of walk) {
    // A share row only `without` holds publishes nothing yet.
    const shareRow = member.external.versions.find(
      v => v.action === 'share' && v.remotes.some(r => r.name !== without)
    );
    if (shareRow) claim(shareRow);
  }
  // A pooled skip copy's specifiers are claimed first by a share row at the global tag (one tag per
  // package), so a stale `cached` only repeats a claim.
  for (const member of walk)
    for (const version of member.external.versions) if (version.action === 'skip') claim(version);
}
