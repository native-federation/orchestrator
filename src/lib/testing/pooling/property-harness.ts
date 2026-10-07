import fc from 'fast-check';
import { GLOBAL_SCOPE, type ImportMap, type RemoteEntry, type shareScope } from 'lib/core/1.domain';
import { NFError } from 'lib/core/native-federation.error';
import { acceptsTag } from 'lib/core/1.domain/externals/compatibility';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import * as _path from 'lib/utils/path';
import { type GroupTear, tearsByPool } from './no-tear';
import { hostOf, scopeUrlOf, toRemoteEntries, type PortfolioSpec } from './generate-portfolio';
import { portfolio } from './portfolio';

/**
 * What the pooling property specs (`pooling.property.init.spec.ts`, `pooling.property.dynamic.spec.ts`)
 * share: the seeded `run`, a page sequence on `portfolio()` (`openPortfolio`, `initOrRefuse`), the per-pool
 * oracles, and the election rules restated for the quality properties.
 */

// A deeper local search: POOLING_PROPERTY_SEED=<n> POOLING_PROPERTY_SCALE=<factor> (CI uses the defaults).
const CI_SEED = 20261007;
const SEED = Number(process.env['POOLING_PROPERTY_SEED'] ?? CI_SEED);
const SCALE = Number(process.env['POOLING_PROPERTY_SCALE'] ?? 1);
const versionCheck = createVersionCheck();

// A deeper search runs proportionally longer.
export const TIMEOUT = 10_000 * SCALE;

// Every property passes its own `seedOffset`, so no two replay one stream of portfolios. fast-check stops
// short of the test timeout so that a failure still reports its counterexample, shrunk as far as it got.
// `fixed` replays the CI stream whatever the deeper search asks and stops at the first failure unshrunk: for an
// `it.fails` property, which must keep failing and has nothing to report.
export const run = <T>(
  seedOffset: number,
  arbitrary: fc.Arbitrary<T>,
  numRuns: number,
  predicate: (v: T) => Promise<void>,
  { fixed = false }: { fixed?: boolean } = {}
) =>
  fc.assert(fc.asyncProperty(arbitrary, predicate), {
    seed: (fixed ? CI_SEED : SEED) + seedOffset,
    numRuns: fixed ? numRuns : Math.ceil(numRuns * SCALE),
    interruptAfterTimeLimit: TIMEOUT * 0.7,
    endOnFailure: fixed,
  });

export const scopeUrlsOf = (entries: RemoteEntry[]) =>
  Object.fromEntries(entries.map(e => [e.name, scopeUrlOf(e.name)]));

// Per pool as the record names it, for the checks that read verdicts rather than run the oracle.
export function pools(record: shareScope): Map<string, shareScope> {
  const byPool = new Map<string, shareScope>();
  for (const [name, external] of Object.entries(record)) {
    if (external.poolName === undefined) continue;
    let members = byPool.get(external.poolName);
    if (!members) byPool.set(external.poolName, (members = {}));
    members[name] = external;
  }
  return byPool;
}

// The oracle per stored pool. Unpooled packages are left out on purpose: outside a pool the import-map
// builders self-fill an entrypoint the shared version lacks from the consumer's own build, a documented
// between-versions tear that pooling makes no promise about.
export function poolTears(
  importMap: ImportMap,
  record: shareScope,
  scopeUrls: Record<string, string>,
  host?: string
): GroupTear[] {
  return tearsByPool({
    importMap,
    externals: { [GLOBAL_SCOPE]: record },
    scopeUrls,
    hosts: host === undefined ? [] : [host],
  }).filter(tear => !tear.pool.startsWith(`${GLOBAL_SCOPE}|package:`));
}

// Every `pool|remote|oracle` that tears, for comparing two maps rather than asserting on one.
export function torn(
  importMap: ImportMap,
  record: shareScope,
  scopeUrls: Record<string, string>,
  host?: string
): string[] {
  return poolTears(importMap, record, scopeUrls, host)
    .flatMap(({ pool, incoherent, split }) => [
      ...incoherent.map(({ remote }) => `${pool}|${remote}|incoherent`),
      ...split.map(({ remote }) => `${pool}|${remote}|split`),
    ])
    .sort();
}

// `strictExternalCompatibility` may only refuse a portfolio in which some strict copy's range rejects a tag
// of its external other than the one it ships itself (a copy never rejects its own version).
function hasForeignRejection(entries: RemoteEntry[]): boolean {
  const tags = new Map<string, Set<string>>();
  for (const entry of entries)
    for (const s of entry.shared)
      if (s.singleton && s.version) {
        if (!tags.has(s.packageName)) tags.set(s.packageName, new Set());
        tags.get(s.packageName)!.add(s.version);
      }

  return entries.some(entry =>
    entry.shared.some(
      s =>
        s.singleton &&
        s.strictVersion &&
        [...(tags.get(s.packageName) ?? [])].some(
          tag =>
            versionCheck.compare(tag, s.version!) !== 0 &&
            !versionCheck.isCompatible(tag, s.requiredVersion)
        )
    )
  );
}

let namespaces = 0;

// The refusals of the two strict steps, pooling and the resolver; anything else under strict is a crash.
const REFUSALS = [
  /^Could not pool '[^']+' in scope /,
  /^Could not determine shared externals in scope /,
];

// One page sequence on `portfolio()`: every `init` after the first opens a warm page that skips what it has
// cached, as get-remote-entries does; `load` adds a remote at runtime on a new page.
export function openPortfolio(o: { host?: string; strict?: boolean } = {}) {
  const p = portfolio(
    {},
    {
      hosts: o.host === undefined ? [] : [o.host],
      strict: o.strict,
      storage: `nf-pooling-property-${namespaces++}`,
      realRepositories: true,
      assertNoTear: false,
    }
  );
  let opened = false;
  const next = () => {
    if (opened) p.reload();
    opened = true;
  };
  const result = (importMap: ImportMap) => ({
    importMap,
    record: structuredClone(p.stored()),
    writes: p.writes(),
  });

  return {
    // Where each remote is served from, as the flows stored it: a redeployed remote moves.
    scopeUrls: p.scopeUrls,
    async init(entries: RemoteEntry[]) {
      next();
      return result(await p.runInit(entries));
    },
    // A warm page that re-elects every pool.
    async reelect() {
      next();
      return result(await p.reelect());
    },
    async load(entry: RemoteEntry) {
      next();
      const { importMap: delta, merged } = await p.runDynamic(structuredClone(entry));
      return { delta, merged, record: structuredClone(p.stored()) };
    },
  };
}

// Inits the spec. Under `strictExternalCompatibility` a refusal is legal only when it is sound (some strict
// copy rejects a foreign tag) and is the refusal itself: an `NFError` from pooling or the resolver. The
// caller's checks are skipped for it.
export async function initOrRefuse(spec: PortfolioSpec) {
  const entries = toRemoteEntries(spec);
  const host = hostOf(spec);
  const rig = openPortfolio({ strict: spec.strict, host });
  try {
    const result = await rig.init(entries);
    return { ok: true as const, result, rig, entries, host };
  } catch (error) {
    if (!spec.strict) throw error;
    expect(error).toBeInstanceOf(NFError);
    const message = (error as Error).message;
    expect({ message, refusal: REFUSALS.some(r => r.test(message)) }).toEqual({
      message,
      refusal: true,
    });
    expect(hasForeignRejection(entries)).toBe(true);
    return { ok: false as const, entries, host };
  }
}

// The map and record up to interchangeable providers: which tag each remote runs per specifier it ships, and
// each copy's verdict. Which of two copies of one tag publishes a file is basis precedence, i.e. arrival.
// `scopeUrls` is needed only once a remote was redeployed to another URL.
export function outcome(
  importMap: ImportMap,
  record: shareScope,
  scopeUrls: Record<string, string> = {}
) {
  const scopeUrl = (remote: string) => scopeUrls[remote] ?? scopeUrlOf(remote);
  const tagOfUrl = new Map<string, string>();
  for (const external of Object.values(record))
    for (const version of external.versions)
      for (const meta of version.remotes)
        for (const file of Object.values(meta.entries))
          tagOfUrl.set(_path.join(scopeUrl(meta.name), file), version.tag);

  const runs: Record<string, string | null> = {};
  const verdicts: Record<string, unknown> = {};
  for (const [name, external] of Object.entries(record))
    for (const version of external.versions)
      for (const meta of version.remotes) {
        verdicts[`${name}|${meta.name}`] = {
          tag: version.tag,
          action: version.action,
          poolName: external.poolName,
          poolCause: meta.poolCause,
          servedBy: meta.servedBy !== undefined,
        };
        for (const specifier of Object.keys(meta.entries)) {
          const url =
            importMap.scopes?.[scopeUrl(meta.name)]?.[specifier] ?? importMap.imports[specifier];
          runs[`${meta.name}|${specifier}`] = url === undefined ? null : (tagOfUrl.get(url) ?? url);
        }
      }
  return { runs, verdicts };
}

export const lenient = (spec: PortfolioSpec): PortfolioSpec => ({ ...spec, strict: false });

export const accepts = acceptsTag(versionCheck.isCompatible, versionCheck.compare);

// One copy of a pool member, as the quality properties read it.
type PoolCopy = {
  remote: string;
  member: string;
  tag: string;
  range: string;
  entries: Record<string, string>;
  specifiers: string[];
  poolCause?: string;
  servedBy?: string;
};

export function copiesOf(members: shareScope): PoolCopy[] {
  return Object.entries(members).flatMap(([member, external]) =>
    external.versions.flatMap(version =>
      version.remotes.map(meta => ({
        remote: meta.name,
        member,
        tag: version.tag,
        range: meta.requiredVersion,
        entries: meta.entries,
        specifiers: Object.keys(meta.entries),
        poolCause: meta.poolCause,
        servedBy: meta.servedBy,
      }))
    )
  );
}

// The tag `imports` serves each of the pool's specifiers at, read off the map: a URL names the copy whose file it
// is, and so its tag.
export function electedTags(importMap: ImportMap, copies: PoolCopy[]): Map<string, string> {
  const tagOfUrl = new Map<string, string>();
  for (const copy of copies)
    for (const file of Object.values(copy.entries))
      tagOfUrl.set(_path.join(scopeUrlOf(copy.remote), file), copy.tag);
  const elected = new Map<string, string>();
  for (const copy of copies)
    for (const specifier of copy.specifiers) {
      const url = importMap.imports[specifier];
      if (url !== undefined) elected.set(specifier, tagOfUrl.get(url) ?? url);
    }
  return elected;
}

/**
 * What the election rules (docs/version-resolver.md §"How pooling resolves") read about one remote against the
 * elected tags, restated independently of `election.ts`:
 * - `rejects`: a copy's range rejects the elected tag of a specifier it ships (its own tag never);
 * - `missing`: the global map serves no tag for one of its specifiers;
 * - `witnessed`: one build of `builds` shipped every one of its specifiers at the elected tag, a build's package
 *   tag standing in for an entrypoint it does not list (the witness rule the extension applies);
 * - `agrees`: every tag it ships is the elected one, compared through the package where the map lacks the
 *   specifier (the dynamic gate's shortcut to the global map).
 */
export function judgeRemote(
  remote: string,
  copies: PoolCopy[],
  elected: Map<string, string>,
  builds: string[]
) {
  const own = copies.filter(c => c.remote === remote);
  const memberTag = (copy: PoolCopy) =>
    copies
      .filter(c => c.member === copy.member)
      .flatMap(c => c.specifiers)
      .map(s => elected.get(s))
      .find(tag => tag !== undefined);
  const buildTag = (build: string, member: string) =>
    copies.find(c => c.remote === build && c.member === member)?.tag;

  return {
    rejects: own.some(c =>
      c.specifiers.some(s => elected.has(s) && !accepts(elected.get(s)!, c.tag, c.range))
    ),
    missing: own.some(c => c.specifiers.some(s => !elected.has(s))),
    witnessed: builds.some(build =>
      own.every(c => c.specifiers.every(s => buildTag(build, c.member) === elected.get(s)))
    ),
    agrees: own.every(c => {
      const tag = memberTag(c);
      return c.specifiers.every(
        s => (elected.get(s) ?? tag) === undefined || (elected.get(s) ?? tag) === c.tag
      );
    }),
  };
}

// Range soundness: every pooled copy runs, per specifier it ships, a tag its own range accepts (its own tag
// always counts), read off the map the way the browser resolves it. `only` narrows it to one remote.
export function rangeViolations(importMap: ImportMap, record: shareScope, only?: string): string[] {
  const out: string[] = [];
  for (const [pool, members] of pools(record)) {
    const copies = copiesOf(members);
    const tagOfUrl = new Map<string, string>();
    for (const copy of copies)
      for (const file of Object.values(copy.entries))
        tagOfUrl.set(_path.join(scopeUrlOf(copy.remote), file), copy.tag);
    for (const copy of copies) {
      if (only !== undefined && copy.remote !== only) continue;
      for (const specifier of copy.specifiers) {
        const url =
          importMap.scopes?.[scopeUrlOf(copy.remote)]?.[specifier] ?? importMap.imports[specifier];
        // No tag means the URL is no file of this pool: an unmapped specifier is `assertResolves`' failure
        // (portfolio.ts, every init and load); a URL from outside the pool is not judged here.
        const tag = url === undefined ? undefined : tagOfUrl.get(url);
        if (tag !== undefined && !accepts(tag, copy.tag, copy.range))
          out.push(`${pool}|${copy.remote}|${specifier}: runs ${tag}, range ${copy.range}`);
      }
    }
  }
  return out;
}

// Pool state that names a remote must name one that ships the pool: each member's `poolWinner`, and the
// `servedBy` of each copy.
export function strayNames(record: shareScope): string[] {
  const out: string[] = [];
  for (const [pool, members] of pools(record)) {
    const shippers = new Set(copiesOf(members).map(c => c.remote));
    for (const [name, external] of Object.entries(members)) {
      if (external.poolWinner !== undefined && !shippers.has(external.poolWinner))
        out.push(`${pool}|${name}: poolWinner ${external.poolWinner}`);
      for (const version of external.versions)
        for (const meta of version.remotes)
          if (meta.servedBy !== undefined && !shippers.has(meta.servedBy))
            out.push(`${pool}|${name}|${meta.name}: servedBy ${meta.servedBy}`);
    }
  }
  return out;
}

// Where pooling placed one remote: the causes on its copies and the builds they run.
export function placementOf(remote: string, copies: PoolCopy[]) {
  const own = copies.filter(c => c.remote === remote);
  return {
    causes: [...new Set(own.flatMap(c => c.poolCause ?? []))],
    servedBy: [...new Set(own.flatMap(c => c.servedBy ?? []))],
    // A subpool's build serves itself too (`servedBy: <itself>`); that is a subpool only with other members.
    servesOthers: copies.some(c => c.remote !== remote && c.servedBy === remote),
  };
}
