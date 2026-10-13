import {
  type ExternalName,
  GLOBAL_SCOPE,
  type RemoteName,
  type SharedInfoActions,
  type SharedVersionMeta,
  type VersionName,
} from 'lib/core/1.domain';
import { committedClaims } from 'lib/core/1.domain/externals/claims';
import type { AcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { packageOf, type Specifier, SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import * as _path from 'lib/utils/path';
import { type Build, buildOf, type Copy, type IsChunked } from './builds';
import type { PoolMember } from './membership';
import { agrees, tearsPackage, unwitnessedGap } from './rules';

// See docs/version-resolver.md §"Scope and dynamic init".

// One file: the remote whose scope URL it lives under, and its name there.
type Served = { tag: VersionName; remote: RemoteName; file: string };

type CommittedView = {
  builds: Map<RemoteName, Build>;
  // What the committed global map serves per specifier: `imports`, or the shareScope's scopes.
  global: Map<Specifier, Served>;
  // Per build, the specifiers it runs from its own or a subpool's files, at the tag it runs.
  runsOffMap: Map<RemoteName, Map<Specifier, Served>>;
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

type MappedFiles = { covered: Set<Specifier>; override: Record<Specifier, string> };

// One of the remote's copies the map may cover, with its action and what the map would serve of it.
type Coverable = MappedFiles & {
  member: PoolMember;
  action: SharedInfoActions[string];
  copy: SharedVersionMeta;
};

// Where the remote resolves a specifier it ships: the map's file, or its own.
type Reach = { remote: RemoteName; file: string; chunked: boolean };

type MapPolicy = {
  shareScope: string;
  selfFill: boolean;
  isChunked: IsChunked;
  scopeUrlOf: (remote: RemoteName) => string | undefined;
};

// A `scope` copy counts as served by its build: its files are already in the map under its own scope.
// `without`'s build is left out of `builds` too.
export function committedView(
  members: PoolMember[],
  shipped: ReadonlyMap<RemoteName, readonly Copy[]>,
  recordOrder: ExternalName[],
  { shareScope, without }: { shareScope: string; without?: RemoteName }
): CommittedView {
  const global: CommittedView['global'] = new Map();

  // Mirrors what `generate-import-map` emitted, so `global` is what the committed map really serves.
  const claims = committedClaims(inRecordOrder(members, recordOrder), { shareScope, without });
  for (const [specifier, { tag, copy }] of claims)
    global.set(specifier, { tag, remote: copy.name, file: copy.entries[specifier]! });

  const builds = new Map<RemoteName, Build>();
  for (const [owner, copies] of shipped)
    if (owner !== without) builds.set(owner, buildOf(owner, copies));

  const fileOf = new Map<RemoteName, Record<Specifier, string>>();
  for (const member of members)
    for (const version of member.external.versions)
      for (const { name, entries } of version.remotes)
        // The first row wins, as in `copiesByRemote`.
        fileOf.set(name, { ...entries, ...fileOf.get(name) });

  const runsOffMap: CommittedView['runsOffMap'] = new Map();
  for (const member of members)
    for (const version of member.external.versions)
      for (const meta of version.remotes) {
        const { servedBy } = meta;
        let runs = runsOffMap.get(meta.name);
        if (!runs) runsOffMap.set(meta.name, (runs = new Map()));
        for (const specifier in meta.entries) {
          // A shared copy runs its own file only for an entrypoint the map lacks.
          if (version.action !== 'scope' && !servedBy && global.has(specifier)) continue;
          // A subpool member's copy keeps its own tag in the record but runs its build's files.
          const tag =
            (servedBy ? builds.get(servedBy)?.tags.pinnedTag(specifier) : undefined) ?? version.tag;
          const file = servedBy && fileOf.get(servedBy)?.[specifier];
          runs.set(
            specifier,
            file
              ? { tag, remote: servedBy, file }
              : { tag, remote: meta.name, file: meta.entries[specifier]! }
          );
        }
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

type Binding = { owner: RemoteName; specifier: Specifier; tag: VersionName };

type CoverResult =
  { covers: MapCover[] } | { unmapped: RemoteName } | { torn: string } | { bound: Binding };

// `covered` is per external, but the map serves by specifier: an entrypoint another member ships as a package
// of its own (flat vs dense) is served all the same. A named scope has no `imports` to inherit, so the remote's
// own scope maps each such specifier to the file the committed map serves it from, replacing the resolver's
// override. Covering fails, and the remote serves the pool itself, when it would run a package partly on the
// map's files and partly on its own chunked ones (`torn`), or reach one specifier at two files (`bound`).
export function coverFromMap(
  remote: RemoteName,
  mine: readonly PoolMember[],
  view: CommittedView,
  actions: Readonly<SharedInfoActions>,
  policy: MapPolicy
): CoverResult {
  const inherited: SharedVersionMeta[] = [];
  const files: Coverable[] = [];
  for (const member of mine) {
    const action = actions[member.name]!;
    const copy = member.external.versions.flatMap(v => v.remotes).find(r => r.name === remote);
    if (!copy) continue;
    // Inherits every mapping already.
    if (action.action === 'skip' && !action.covered) {
      inherited.push(copy);
      continue;
    }

    const mapped = mapFiles(copy, view, policy, action);
    if ('unmapped' in mapped) return mapped;
    files.push({ member, action, copy, ...mapped });
  }

  const reaches = reachesOf(remote, inherited, files, view, policy);
  const torn = tornPackage(remote, reaches);
  if (torn !== undefined) return { torn };
  const bound = boundByFile(reaches, view);
  if (bound !== undefined) return { bound };
  return { covers: files.filter(file => covering(file, policy)).map(coverOf) };
}

function covering({ action, copy, covered }: Coverable, policy: MapPolicy): boolean {
  const partial = covered.size < Object.keys(copy.entries).length;
  return action.action === 'skip' || (covered.size > 0 && (!partial || policy.selfFill));
}

function coverOf({ member, action, copy, covered, override }: Coverable): MapCover {
  // A copy that joined a share row would claim, on the next page, what the map serves from another member.
  const toSkip =
    action.action !== 'skip' ||
    (covered.size > action.covered!.length &&
      member.external.versions.some(v => v.action === 'share' && v.remotes.includes(copy)));
  return { name: member.name, toSkip, covered: [...covered], override };
}

// Where the remote resolves each specifier it ships once the covers apply: the map's file, else its own.
function reachesOf(
  remote: RemoteName,
  inherited: readonly SharedVersionMeta[],
  files: readonly Coverable[],
  view: CommittedView,
  policy: MapPolicy
): Map<Specifier, Reach> {
  const reaches = new Map<Specifier, Reach>();
  const fromMap = (specifier: Specifier): Reach | undefined => {
    const served = view.global.get(specifier);
    return served && { remote: served.remote, file: served.file, chunked: false };
  };
  for (const copy of inherited)
    for (const specifier in copy.entries) {
      const reach = fromMap(specifier);
      if (reach) reaches.set(specifier, reach);
    }
  for (const file of files) {
    const takesMap = covering(file, policy);
    const chunked = policy.isChunked(remote, file.copy.bundle);
    for (const [specifier, own] of Object.entries(file.copy.entries)) {
      if (!takesMap || !file.covered.has(specifier))
        reaches.set(specifier, { remote, file: own, chunked });
      else {
        const reach = fromMap(specifier);
        if (reach) reaches.set(specifier, reach);
      }
    }
  }
  return reaches;
}

function tornPackage(remote: RemoteName, reaches: ReadonlyMap<Specifier, Reach>) {
  const mapped = new Set<string>();
  for (const [specifier, { remote: from }] of reaches)
    if (from !== remote) mapped.add(packageOf(specifier));
  for (const [specifier, { remote: from, chunked }] of reaches)
    if (from === remote && tearsPackage(chunked, specifier, mapped)) return packageOf(specifier);
  return undefined;
}

// U-27 by file: a committed file binds its pool-mates where its build resolves them (off the map where it runs
// them so, else the map), so every build whose file the remote reaches, directly or through another such file,
// must resolve each specifier it ships to the file the remote does, or the one the first such build does.
function boundByFile(
  reaches: ReadonlyMap<Specifier, Reach>,
  view: CommittedView
): Binding | undefined {
  const servers = new Set<RemoteName>();
  for (const { remote } of reaches.values()) if (view.builds.has(remote)) servers.add(remote);

  const firstRun = new Map<Specifier, { remote: RemoteName; file: string }>();
  // A Set iterates what is added during the loop, so a build first reached through another's file is judged too.
  for (const build of servers)
    for (const specifier of view.builds.get(build)!.tags.keys()) {
      const served = view.runsOffMap.get(build)?.get(specifier) ?? view.global.get(specifier);
      if (served === undefined) continue;
      const reached = reaches.get(specifier) ?? firstRun.get(specifier);
      if (reached === undefined) {
        firstRun.set(specifier, served);
        if (view.builds.has(served.remote)) servers.add(served.remote);
      } else if (reached.remote !== served.remote || reached.file !== served.file)
        return { owner: build, specifier, tag: served.tag };
    }
  return undefined;
}

function mapFiles(
  copy: SharedVersionMeta,
  view: CommittedView,
  policy: MapPolicy,
  action: SharedInfoActions[string]
): MappedFiles | { unmapped: RemoteName } {
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
    for (const [specifier, { tag }] of view.runsOffMap.get(build) ?? []) {
      const reached =
        globalTags.pinnedTag(specifier) ??
        own.pinnedTag(specifier) ??
        firstRun.pinnedTag(specifier);
      if (reached === undefined) firstRun.set(specifier, tag);
      else if (reached !== tag) return { owner: build, specifier, tag };
    }
  return undefined;
}

function inRecordOrder(members: PoolMember[], recordOrder: ExternalName[]) {
  const rank = new Map(recordOrder.map((name, i) => [name, i]));
  return [...members]
    .sort((a, b) => rank.get(a.name)! - rank.get(b.name)!)
    .map(m => [m.name, m.external] as const);
}
