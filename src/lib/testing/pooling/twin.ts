import { GLOBAL_SCOPE, type ImportMap, type shareScope } from 'lib/core/1.domain';
import {
  hostOf,
  scopeUrlOf,
  toRemoteEntries,
  toRemoteEntry,
  type PortfolioSpec,
} from './generate-portfolio';
import { openPortfolio, rangeViolations, scopeUrlsOf, torn } from './property-harness';

/**
 * The twin oracle for dynamic pooling (global-or-self). A twin T is a renamed clone of a committed remote R,
 * loaded at runtime. Per pooled specifier T ships, T's placement is held against R's in the init record:
 * - R global => T resolves to R's URL; where R's own scope ran R's own file, T may run its own copy at the
 *   same relative path (`same-file`).
 * - R off the map (self, subpool member, subpool build) => T self, or a CHECKED global: no tear, every
 *   specifier resolves, ranges accept, one build shipped the tags T runs together (`witness`), every
 *   map-served specifier maps the committed file (`iv`), and R's cause is not `incompatible` (`rejected`).
 * - T in a subpool => `subpool`: runtime subpool joining, which dynamic pooling does not do.
 * Only pooled specifiers are compared (an unpooled self-fill is not pooling's), and a case whose R tears in the
 * committed map is skipped. Each global off R's placement is tagged with its shape: KB (R ran its own build as
 * a subpool build), AG-i (R self), SG (R a subpool member), PUB (T runs its own file from a share row it opened).
 */

type TwinRed = {
  check:
    | 'throws'
    | 'unresolved'
    | 'tear'
    | 'range'
    | 'same-file'
    | 'subpool'
    | 'witness'
    | 'iv'
    | 'rejected';
  specifier?: string;
  detail?: unknown;
};
type TwinGlobal = { specifier: string; shape: 'KB' | 'AG-i' | 'SG' | 'PUB' };

function verdict(record: shareScope, remote: string, specifier: string) {
  for (const [name, external] of Object.entries(record))
    for (const version of external.versions)
      for (const meta of version.remotes)
        if (meta.name === remote && specifier in meta.entries)
          return {
            external: name,
            tag: version.tag,
            action: version.action,
            pool: external.poolName,
            ...(meta.servedBy && { servedBy: meta.servedBy }),
            ...(meta.poolCause && { cause: meta.poolCause }),
          };
  return undefined;
}

export async function twinGate(
  spec: PortfolioSpec,
  source: number
): Promise<{
  R: string;
  T: string;
  skipped?: 'R torn';
  reds: TwinRed[];
  globals: TwinGlobal[];
  // The record after the twin's load.
  record?: shareScope;
}> {
  const scope = spec.shareScope;
  const entries = toRemoteEntries(spec);
  const host = hostOf(spec);
  const rig = openPortfolio({
    host,
    latestSharedExternal: spec.latestSharedExternal,
    scopeUncoveredEntrypoints: spec.scopeUncoveredEntrypoints,
    ...(scope && { scope }),
  });
  const init = await rig.init(entries);
  const twin = toRemoteEntry(spec.remotes[source]!, entries.length, 0, scope);
  const R = entries[source]!.name;
  const T = twin.name;
  const shareScope = scope ?? GLOBAL_SCOPE;
  const globals: TwinGlobal[] = [];
  if (
    torn(init.importMap, init.record, scopeUrlsOf(entries), host, shareScope).some(t =>
      t.includes(`|${R}|`)
    )
  )
    return { R, T, skipped: 'R torn', reds: [], globals };

  let load: Awaited<ReturnType<typeof rig.load>>;
  try {
    load = await rig.load(twin);
  } catch (error) {
    return { R, T, reds: [{ check: 'throws', detail: String(error) }], globals };
  }
  const { merged, record } = load;
  const reds: TwinRed[] = [];
  const scopeR = scopeUrlOf(R);
  const scopeT = scopeUrlOf(T);

  if (
    torn(merged, record, scopeUrlsOf([...entries, twin]), host, shareScope).some(t =>
      t.includes(`|${T}|`)
    )
  )
    reds.push({ check: 'tear' });
  for (const v of rangeViolations(merged, record, T)) reds.push({ check: 'range', detail: v });

  const memberOf = new Map<string, { pool: string; member: string }>();
  for (const [name, external] of Object.entries(record))
    if (external.poolName !== undefined)
      for (const version of external.versions)
        for (const meta of version.remotes)
          if (meta.name === T)
            for (const s of Object.keys(meta.entries))
              memberOf.set(s, { pool: external.poolName, member: name });
  const tagOfUrl = new Map<string, string>();
  // remote -> member -> the tag its build ships
  const buildTags = new Map<string, Map<string, string>>();
  for (const [name, external] of Object.entries(record))
    for (const version of external.versions)
      for (const meta of version.remotes) {
        for (const file of Object.values(meta.entries))
          tagOfUrl.set(scopeUrlOf(meta.name) + file, version.tag);
        if (!buildTags.has(meta.name)) buildTags.set(meta.name, new Map());
        if (!buildTags.get(meta.name)!.has(name)) buildTags.get(meta.name)!.set(name, version.tag);
      }
  const urlIn = (map: ImportMap, remote: string, s: string) =>
    map.scopes?.[scopeUrlOf(remote)]?.[s] ?? map.imports[s];
  const viaScope = (map: ImportMap, remote: string, s: string) =>
    map.scopes?.[scopeUrlOf(remote)]?.[s] !== undefined;
  // The file the committed map serves a specifier at in this share scope; undefined when map-less or ambiguous.
  const committed = (s: string) => {
    if (scope === undefined) return init.importMap.imports[s];
    const urls = new Set(
      entries.flatMap(e => init.importMap.scopes?.[scopeUrlOf(e.name)]?.[s] ?? [])
    );
    return urls.size === 1 ? [...urls][0] : undefined;
  };

  const checkedPools = new Set<string>();
  for (const s of [...memberOf.keys()].sort()) {
    const tUrl = urlIn(merged, T, s);
    if (tUrl === undefined) {
      reds.push({ check: 'unresolved', specifier: s });
      continue;
    }
    const r = verdict(init.record, R, s);
    const t = verdict(record, T, s);
    if (r === undefined) continue;
    const rUrl = urlIn(init.importMap, R, s);
    const detail = { R: r, T: t, rUrl, tUrl };
    if (!r.cause && !r.servedBy) {
      const sameFile =
        tUrl === rUrl ||
        (rUrl !== undefined &&
          rUrl.startsWith(scopeR) &&
          viaScope(init.importMap, R, s) &&
          tUrl === scopeT + rUrl.slice(scopeR.length));
      if (!sameFile) reds.push({ check: 'same-file', specifier: s, detail });
      continue;
    }
    if (tUrl.startsWith(scopeT)) {
      if (t?.action === 'share' && !t.cause && !t.servedBy)
        globals.push({ specifier: s, shape: 'PUB' });
      continue;
    }
    if (t?.servedBy !== undefined && t.servedBy !== T) {
      reds.push({ check: 'subpool', specifier: s, detail });
      continue;
    }
    const shape = r.cause ? 'AG-i' : r.servedBy === R ? 'KB' : 'SG';
    globals.push({ specifier: s, shape });
    if (shape !== 'KB' && r.cause === 'incompatible')
      reds.push({ check: 'rejected', specifier: s, detail });
    const c = committed(s);
    if (c !== undefined && tUrl !== c)
      reds.push({ check: 'iv', specifier: s, detail: { ...detail, committed: c } });
    checkedPools.add(memberOf.get(s)!.pool);
  }

  for (const pool of checkedPools) {
    const runs = [...memberOf]
      .filter(([, m]) => m.pool === pool)
      .map(([s, m]) => ({ s, member: m.member, tag: tagOfUrl.get(urlIn(merged, T, s) ?? '') }));
    const witnessed = [...buildTags.values()].some(tags =>
      runs.every(x => x.tag !== undefined && tags.get(x.member) === x.tag)
    );
    if (!witnessed) reds.push({ check: 'witness', detail: { pool, runs } });
  }
  return { R, T, reds, globals, record };
}
