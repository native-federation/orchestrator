import type { ForPoolingDynamicExternals } from '../../driver-ports/init/for-pooling-dynamic-externals.port';
import type { ModeConfig } from '../../config/mode.contract';
import type { LoggingConfig } from '../../config/log.contract';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import {
  type ExternalName,
  GLOBAL_SCOPE,
  type PoolCause,
  type RemoteName,
  STRICT_SCOPE,
  type SharedExternal,
  type SharedInfoActions,
  type SharedVersionMeta,
} from 'lib/core/1.domain';
import { buildPools, type PoolMember } from 'lib/core/1.domain/pooling/membership';
import { renamesOf } from 'lib/core/1.domain/pooling/plan';
import { scopeHasPoolState } from 'lib/core/1.domain/pooling/pool-state';
import { type Specifier, SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import {
  basisPerMember,
  type CommittedView,
  committedView,
  consumedMembers,
  consumedSpecifiers,
  hostRemotes,
} from 'lib/core/1.domain/pooling/views';
import { lazy, writePoolNames } from './pool.util';
import { acceptanceTable, acceptsAll, covers, type Acceptance } from './subpool-fit';
import * as _path from 'lib/utils/path';
import { acceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { addRemoteToVersion } from 'lib/core/1.domain/externals/basis';
import { compareStrings } from 'lib/utils/compare-strings';

// What the gate decided for the loaded remote's copy of one member, as the record must keep it.
type Verdict = { cause: PoolCause } | { servedBy: RemoteName } | { fromMap: true };

// Why the loaded remote cannot resolve through the committed map, worded for the log.
type Miss = { cause: PoolCause; gap: string };

// One pool as both gates read it, for the remote being loaded.
type GateViews = {
  pool: PoolMember[];
  view: CommittedView;
  wants: ExternalName[];
  specifiers: Set<Specifier>;
  acceptance: () => Acceptance;
};

export function createPoolDynamicExternals(
  config: LoggingConfig & ModeConfig,
  ports: Pick<DrivingContract, 'sharedExternalsRepo' | 'remoteInfoRepo' | 'versionCheck'>
): ForPoolingDynamicExternals {
  // Read per call so a port swapped after wiring is honoured.
  const accepts = acceptsTag(
    (tag, range) => ports.versionCheck.isCompatible(tag, range),
    (a, b) => ports.versionCheck.compare(a, b)
  );

  // The committed map is immutable, so this only rewrites the loaded remote's own actions and copies, never
  // another remote's. See docs/version-resolver.md §"Scope and dynamic init".
  return ({ entry, actions }) => {
    // The poolable singletons whose actions may be rewritten; membership comes from the record.
    const declared = new Map<string, Set<ExternalName>>();
    for (const external of entry.shared ?? []) {
      const name = external.packageName;
      if (!external.singleton || !actions[name]) continue;
      if (external.shareScope === STRICT_SCOPE) continue;

      const shareScope = external.shareScope ?? GLOBAL_SCOPE;
      let names = declared.get(shareScope);
      if (!names) declared.set(shareScope, (names = new Set()));
      names.add(name);
    }
    if (declared.size === 0) return Promise.resolve({ entry, actions });

    // Per share scope, the loaded remote's verdicts to write back, so a reload rebuilds the map this
    // delta publishes rather than the one `update-cache` recorded.
    let verdicts = new Map<ExternalName, Verdict>();

    const scope = (name: string, cause: PoolCause) => {
      actions[name]!.action = 'scope';
      delete actions[name]!.override;
      delete actions[name]!.covered;
      verdicts.set(name, { cause });
    };

    for (const [shareScope, names] of declared) {
      // A tag anywhere in the committed scope forms pools this entry is subject to — its own tag is not
      // required, and the pool covers the whole external, this entry's copies included.
      const committed = ports.sharedExternalsRepo.getFromScope(shareScope);
      if (!scopeHasPoolState(committed)) continue;

      const { pools } = buildPools(committed);
      verdicts = new Map();

      for (const pool of pools.values()) {
        // Only the members this entry declares have an action to rewrite; the rest of the pool is context —
        // its builds are candidates and its committed tags are what the gate reads.
        const mine = pool.filter(member => names.has(member.name));
        if (mine.length === 0) continue;

        try {
          const asked = gateViews(entry.name, pool);
          // The resolver scoping a member means the committed map cannot serve it — a range rejects its tag,
          // or under `scopeUncoveredEntrypoints` it lacks an entrypoint — so no committed build is trusted
          // with this remote: it serves its whole family itself, no dedup.
          const resolverScoped = mine.find(m => actions[m.name]!.action === 'scope');
          const verdict = resolverScoped
            ? missOf(entry.name, asked, resolverScoped.name)
            : judge(entry.name, asked);
          if (verdict === 'global') {
            const served = serveFromMap(entry.name, mine, asked.view, actions, shareScope);
            if ('unmapped' in served) {
              // Half its family on the map's files and half on its own build would tear it.
              warnUnmapped(shareScope, entry.name, served.unmapped);
              mine.forEach(member => scope(member.name, 'uncovered'));
              continue;
            }
            for (const name of served.skipped) verdicts.set(name, { fromMap: true });
            continue;
          }

          const subpool = resolverScoped ? undefined : subpoolFor(entry.name, asked, shareScope);
          if (subpool === undefined) {
            config.log.warn(
              8,
              `[${shareScope}] ${selfServeWarning(entry.name, verdict, mine.length)}`
            );
            mine.forEach(member => scope(member.name, verdict.cause));
            continue;
          }

          for (const name of redirect(entry.name, subpool, pool, asked.view, actions))
            verdicts.set(name, { servedBy: subpool.build });
        } catch (error) {
          // Its own build is the one family this remote can always resolve coherently.
          config.log.error(
            8,
            `[${shareScope}][${entry.name}] could not judge its pool; it serves its own family.`,
            error
          );
          mine.forEach(member => scope(member.name, 'uncovered'));
        }
      }

      const written: Record<string, SharedExternal> = {};
      for (const [name, verdict] of verdicts) {
        written[name] = recordVerdict(committed[name]!, entry.name, verdict);
        ports.sharedExternalsRepo.addOrUpdate(name, written[name], shareScope);
      }
      const merged = { ...committed, ...written };
      writePoolNames(merged, renamesOf(merged, pools), ports.sharedExternalsRepo, shareScope);
    }

    return Promise.resolve({ entry, actions });
  };

  // Everything the decision reads about one pool, built once; only the version table is worth deferring.
  function gateViews(remote: RemoteName, pool: PoolMember[]): GateViews {
    return {
      pool,
      view: committedView(withoutRemote(pool, remote)),
      wants: consumedMembers(pool).get(remote) ?? [],
      specifiers: consumedSpecifiers(pool).get(remote) ?? new Set<Specifier>(),
      acceptance: lazy(() => acceptanceTable(pool, accepts)),
    };
  }

  // `update-cache` has already recorded the loaded remote's own copies, but the committed map holds none of
  // them: judging against the record as is would count what the remote adds as served already.
  function withoutRemote(pool: PoolMember[], remote: RemoteName): PoolMember[] {
    return pool.map(member => ({
      name: member.name,
      external: {
        ...member.external,
        versions: member.external.versions
          .map(v => ({ ...v, remotes: v.remotes.filter(r => r.name !== remote) }))
          .filter(v => v.remotes.length > 0),
      },
    }));
  }

  // The init rules against a map that can no longer change (§"Scope and dynamic init", step 2).
  function judge(remote: RemoteName, asked: GateViews): 'global' | Miss {
    const { rejected, missing, agrees } = scan(remote, asked);
    if (rejected) return { cause: 'incompatible', gap: rejected };
    // Agreeing, it resolves its own tags wherever the map serves them: its own build witnesses that.
    if (agrees) return 'global';
    if (missing === undefined && witnessed(remote, asked.pool, asked.view)) return 'global';
    return { cause: 'uncovered', gap: missing ?? 'a combination no committed build shipped' };
  }

  // Why the resolver scoped one of the remote's members, in the terms `judge` reports a miss in.
  function missOf(remote: RemoteName, asked: GateViews, scoped: ExternalName): Miss {
    const { rejected, missing } = scan(remote, asked);
    return rejected
      ? { cause: 'incompatible', gap: rejected }
      : { cause: 'uncovered', gap: missing ?? scoped };
  }

  // The remote's copies against the committed global map: the first tag a range rejects, the first
  // entrypoint the map does not serve, and whether every tag it ships is the map's (its package's included).
  function scan(remote: RemoteName, { pool, view }: GateViews) {
    const globalTags = new SpecifierTags([...view.global].map(([s, { tag }]) => [s, tag] as const));
    let rejected: string | undefined;
    let missing: string | undefined;
    let agrees = true;

    for (const member of pool)
      for (const version of member.external.versions)
        for (const meta of version.remotes) {
          if (meta.name !== remote) continue;
          for (const s in meta.entries) {
            const global = view.global.get(s);
            if (global === undefined) missing ??= s;
            else if (!accepts(global.tag, version.tag, meta.requiredVersion))
              rejected ??= `${s}@${global.tag}`;
            const tag = globalTags.tagOf(s);
            if (tag !== undefined && tag !== version.tag) agrees = false;
          }
        }

    return { rejected, missing, agrees };
  }

  // A committed map need not be one build's — a record from before variant election can serve members from
  // different builds — so what it would hand this remote must be a combination one build shipped. A build
  // shipping a package at a tag witnesses its other entrypoints at it (copies of one version merge).
  function witnessed(remote: RemoteName, pool: PoolMember[], view: CommittedView): boolean {
    const wanted: [Specifier, string][] = [];
    for (const member of pool)
      for (const version of member.external.versions)
        for (const meta of version.remotes)
          if (meta.name === remote)
            for (const s in meta.entries) wanted.push([s, view.global.get(s)!.tag]);

    for (const [, build] of view.builds)
      if (wanted.every(([s, tag]) => build.tags.tagOf(s) === tag)) return true;
    return false;
  }

  // The committed build whose subpool the remote joins (§"Scope and dynamic init", step 3).
  function subpoolFor(
    remote: RemoteName,
    { pool, view, wants, specifiers, acceptance }: GateViews,
    shareScope: string
  ): { build: RemoteName; scopeUrl: string } | undefined {
    const basis = basisPerMember(pool);

    for (const build of candidateOrder(pool, view)) {
      if (build === remote) continue;
      const candidate = view.builds.get(build)!;
      if (!servesItsOwnFamily(build, pool, basis)) continue;
      if (!covers(candidate.coverage, specifiers)) continue;
      if (!acceptsAll(acceptance(), candidate.instance, remote, wants)) continue;
      // Unmappable, it would leave the remote on its own actions: half its family from its own build.
      const scopeUrl = scopeUrlOf(build);
      if (!scopeUrl) {
        warnUnmapped(shareScope, remote, build);
        continue;
      }
      return { build, scopeUrl };
    }

    return undefined;
  }

  // Cheapest first: a build the committed map already serves from costs no override, then the host, whose
  // files are loaded anyway; name keeps the rest reload-stable.
  function candidateOrder(pool: PoolMember[], view: CommittedView): RemoteName[] {
    const serving = new Set<RemoteName>();
    for (const source of view.global.values()) serving.add(source.remote);
    const hosts = hostRemotes(pool);

    const rank = (build: RemoteName) => (serving.has(build) ? 0 : hosts.has(build) ? 1 : 2);

    return [...view.builds.keys()].sort((a, b) => rank(a) - rank(b) || compareStrings(a, b));
  }

  // Every copy the build holds is a basis, `scope`, or served by itself; any other copy binds its modules to
  // somebody else's files, and a consumer deduping onto it would inherit that.
  function servesItsOwnFamily(
    build: RemoteName,
    pool: PoolMember[],
    basis: Map<ExternalName, RemoteName>
  ): boolean {
    let ships = 0;

    for (const member of pool) {
      for (const version of member.external.versions) {
        const meta = version.remotes.find(r => r.name === build);
        if (!meta) continue;
        ships++;
        const own =
          meta.servedBy === build ||
          (meta.servedBy === undefined &&
            (version.action === 'scope' || basis.get(member.name) === build));
        if (!own) return false;
      }
    }

    return ships > 0;
  }

  // Returns the members now deduping onto a build other than the global basis. `covered` is set for every
  // member: it is per external, so an entry of a *different* member would otherwise self-fill from the
  // remote's own build.
  function redirect(
    remote: RemoteName,
    { build, scopeUrl }: { build: RemoteName; scopeUrl: string },
    pool: PoolMember[],
    view: CommittedView,
    actions: SharedInfoActions
  ): ExternalName[] {
    const files = view.builds.get(build)!.coverage;
    const basis = basisPerMember(pool);
    const served: ExternalName[] = [];

    for (const member of pool) {
      const action = actions[member.name];
      if (!action) continue;
      // The build covers everything the remote imports, so a copy the resolver scoped or would have shared
      // dedups onto it too: left as it was, it would run the remote's own file beside the build's.
      action.action = 'skip';

      const own = ownCopy(member.external, remote);
      if (!own) continue;

      const specifiers = Object.keys(own.entries);
      if (specifiers.length === 0) continue;

      const override: Record<string, string> = {};
      for (const specifier of specifiers) {
        if (view.global.get(specifier)?.remote === build) continue;
        const file = files.get(specifier);
        if (file) override[specifier] = _path.join(scopeUrl, file);
      }

      action.covered = specifiers;
      if (Object.keys(override).length > 0) action.override = override;
      if (basis.get(member.name) !== build) served.push(member.name);
    }
    return served;
  }

  // `covered` is per external, but the map serves by specifier: an entrypoint another member ships as a
  // package of its own (flat vs dense) is served all the same. Names the members whose share now skips, or a
  // serving build a named scope cannot map.
  function serveFromMap(
    remote: RemoteName,
    mine: PoolMember[],
    view: CommittedView,
    actions: SharedInfoActions,
    shareScope: string
  ): { skipped: ExternalName[] } | { unmapped: RemoteName } {
    const skipped: ExternalName[] = [];

    for (const member of mine) {
      const action = actions[member.name]!;
      if (action.action === 'scope') continue;
      // Inherits every mapping already.
      if (action.action === 'skip' && !action.covered) continue;
      const own = ownCopy(member.external, remote);
      if (!own) continue;

      const served = servedByMap(own, view, shareScope, action);
      if ('unmapped' in served) return served;
      const { covered, override } = served;

      if (action.action === 'share') {
        const partial = covered.length < Object.keys(own.entries).length;
        if (covered.length === 0 || (partial && !maySelfFill(shareScope))) continue;
        action.action = 'skip';
        skipped.push(member.name);
      }
      action.covered = covered;
      if (Object.keys(override).length > 0) action.override = override;
    }

    return { skipped };
  }

  // The copy's specifiers the map serves, beside what the resolver covered. A named scope has no `imports`
  // to inherit, so the remote's own scope must name each file.
  function servedByMap(
    own: SharedVersionMeta,
    view: CommittedView,
    shareScope: string,
    action: SharedInfoActions[string]
  ): { covered: Specifier[]; override: Record<Specifier, string> } | { unmapped: RemoteName } {
    const covered = new Set(action.covered);
    const override = { ...action.override };

    for (const specifier in own.entries) {
      const source = view.global.get(specifier);
      if (!source || covered.has(specifier)) continue;
      if (shareScope !== GLOBAL_SCOPE) {
        const scopeUrl = scopeUrlOf(source.remote);
        if (!scopeUrl) return { unmapped: source.remote };
        override[specifier] = _path.join(scopeUrl, source.file);
      }
      covered.add(specifier);
    }

    return { covered: [...covered], override };
  }

  // Whether an entrypoint a skip leaves uncovered may come from the remote's own build: the coverage policies
  // refuse it, and so does the next page of a named scope, for a skip-only package, under `strictImportMap`.
  function maySelfFill(shareScope: string): boolean {
    if (config.strict.strictEntryPointCoverage || config.profile.scopeUncoveredEntrypoints)
      return false;
    return shareScope === GLOBAL_SCOPE || !config.strict.strictImportMap;
  }

  function ownCopy(external: SharedExternal, remote: RemoteName): SharedVersionMeta | undefined {
    return external.versions.flatMap(v => v.remotes).find(r => r.name === remote);
  }

  function scopeUrlOf(remote: RemoteName): string | undefined {
    return ports.remoteInfoRepo.tryGet(remote).get()?.scopeUrl;
  }

  function warnUnmapped(shareScope: string, remote: RemoteName, build: RemoteName): void {
    config.log.warn(
      8,
      `[${shareScope}][${remote}] '${build}' is not in the cache, so its files cannot be mapped.`
    );
  }

  // The share row `update-cache` opened for a copy that now runs the map's files becomes a skip: it
  // publishes nothing. A tag keeps one non-scope row, so the copy joins one already there.
  function recordFromMap(external: SharedExternal, remote: RemoteName): SharedExternal {
    // Only a member whose action was `share` gets this verdict, so its copy sits in a share row.
    const opened = external.versions.find(
      v => v.action === 'share' && v.remotes.some(r => r.name === remote)
    )!;
    const meta = { ...opened.remotes.find(r => r.name === remote)!, cached: false };
    const joined = external.versions.find(
      v => v !== opened && v.tag === opened.tag && v.action !== 'scope'
    );

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

  // A fresh record with only the loaded remote's copy moved: into a `scope` row at its tag, kept in place with
  // its subpool's build, or into a skip row that runs the map's files.
  function recordVerdict(
    external: SharedExternal,
    remote: RemoteName,
    verdict: Verdict
  ): SharedExternal {
    if ('fromMap' in verdict) return recordFromMap(external, remote);
    if ('servedBy' in verdict) {
      return {
        ...external,
        versions: external.versions.map(v => ({
          ...v,
          remotes: v.remotes.map(r =>
            r.name === remote ? { ...r, servedBy: verdict.servedBy } : r
          ),
        })),
      };
    }

    const moved: { tag: string; meta: SharedVersionMeta }[] = [];
    const versions = external.versions
      .map(v => {
        const own = v.remotes.find(r => r.name === remote);
        if (!own) return v;
        const { servedBy: _subpool, ...rest } = own;
        const meta = { ...rest, cached: true, poolCause: verdict.cause };
        if (v.action === 'scope')
          return { ...v, remotes: v.remotes.map(r => (r === own ? meta : r)) };
        moved.push({ tag: v.tag, meta });
        return { ...v, remotes: v.remotes.filter(r => r !== own) };
      })
      // A version only the loaded remote held — a `share` it introduced — leaves with it.
      .filter(v => v.remotes.length > 0);

    for (const { tag, meta } of moved) {
      const at = versions.findIndex(v => v.tag === tag && v.action === 'scope');
      if (at >= 0) versions[at] = { ...versions[at]!, remotes: [...versions[at]!.remotes, meta] };
      else versions.push({ tag, action: 'scope', host: false, remotes: [meta] });
    }

    return {
      ...external,
      versions: versions.sort((a, b) => ports.versionCheck.compare(b.tag, a.tag)),
    };
  }
}

// Wording is pinned in `island-warnings.contract.spec.ts` alone; tools read islands from the record.
function selfServeWarning(remote: RemoteName, miss: Miss, members: number): string {
  const where = `All ${members} members it imports are scoped for it.`;
  return miss.cause === 'incompatible'
    ? `'${remote}' is islanded: its range rejects '${miss.gap}' of the committed map. ${where}`
    : `'${remote}' serves its own family: no committed build offers every entrypoint it imports at a version it accepts — '${miss.gap}' is the gap. ${where}`;
}
