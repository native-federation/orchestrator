import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImportMap, shareScope } from 'lib/core/1.domain';
import {
  REALISTIC_HOST,
  realisticPortfolio,
  type RealisticOptions,
} from 'lib/testing/pooling/generate-portfolio';
import { portfolio } from 'lib/testing/pooling/portfolio';
import * as _path from 'lib/utils/path';

/**
 * Golden differential test. A coarse snapshot; the properties and examples are the real guard.
 *
 * Seeded realistic portfolios (`realisticPortfolio`: several Angular builds, partial families, `@ngrx` and
 * `@company` pools, unpooled libs, and a straggler that misses only for coverage) go through the real init
 * steps, then one more remote through the dynamic steps. Three cases: N=10 with a host on a build a patch
 * behind the majority's, N=50 with a host under `strictExternalCompatibility`, and N=100 without a host, so
 * round 1's ranking is still decided by what the builds serve. The import map, the dynamic delta and the
 * stored shared-externals record are hashed from a key-sorted serialization and compared with
 * `pooling.golden.json`. A behaviour-preserving refactor must keep every hash.
 *
 * N=10 is also kept readable in `pooling.golden.projection.json`: per remote and specifier, the tag it runs
 * and whose file that is, then its own copy's tag and verdict. A re-baseline's diff of that file says what
 * moved.
 *
 * Re-baselining is explicit and only for a phase that changes behaviour on purpose:
 *
 *     UPDATE_GOLDEN=1 npx vitest run --coverage.enabled=false src/lib/core/2.app/steps/pooling/pooling.golden.spec.ts
 *
 * then review the fixture diff (the counts beside each hash say what moved) and commit it with the change that
 * caused it. Without `UPDATE_GOLDEN=1` the fixtures are only ever read.
 *
 * On a hash mismatch the failing case's serializations are written to `<os.tmpdir()>/nf-pooling-golden/<case>/`
 * and the failure names that directory: diff them against a run of the baseline commit to see what moved.
 */

const FIXTURE = join(__dirname, 'pooling.golden.json');
const PROJECTION = join(__dirname, 'pooling.golden.projection.json');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const SEED = 4242;

type Case = { name: string; n: number; options: RealisticOptions };

const CASES: Case[] = [
  { name: 'N=10', n: 10, options: { host: true, straggler: true } },
  { name: 'N=50 strict', n: 50, options: { host: true, straggler: true, strict: true } },
  { name: 'N=100', n: 100, options: { straggler: true } },
];

type Golden = Record<
  string,
  {
    importMap: string;
    record: string;
    delta: string;
    dynamicRecord: string;
    imports: number;
    scopes: number;
    pooled: number;
    // Copies placed off the elected build, per `poolCause`, or `subpool`.
    islands: Record<string, number>;
  }
>;

// JSON with object keys sorted at every level; array order is meaningful (basis, newest-first) and kept.
function stable(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

// The page as a reader checks it, per remote and specifier it ships:
// `<tag it runs> <whose file> | <its own tag> <action>[ <poolCause>][ servedBy <build>]`.
function project(
  importMap: ImportMap,
  record: shareScope,
  scopeUrls: Record<string, string>
): Record<string, Record<string, string>> {
  const fileOf = new Map<string, { tag: string; remote: string }>();
  for (const external of Object.values(record))
    for (const version of external.versions)
      for (const meta of version.remotes)
        for (const file of Object.values(meta.entries))
          fileOf.set(_path.join(scopeUrls[meta.name]!, file), {
            tag: version.tag,
            remote: meta.name,
          });

  const out: Record<string, Record<string, string>> = {};
  for (const external of Object.values(record))
    for (const version of external.versions)
      for (const meta of version.remotes)
        for (const specifier of Object.keys(meta.entries)) {
          const url =
            importMap.scopes?.[scopeUrls[meta.name]!]?.[specifier] ?? importMap.imports[specifier];
          const runs = url === undefined ? undefined : fileOf.get(url);
          const verdict = [
            version.tag,
            version.action,
            ...(meta.poolCause ? [meta.poolCause] : []),
            ...(meta.servedBy ? [`servedBy ${meta.servedBy}`] : []),
          ].join(' ');
          (out[meta.name] ??= {})[specifier] =
            `${runs ? `${runs.tag} ${runs.remote}` : (url ?? 'unmapped')} | ${verdict}`;
        }
  return JSON.parse(stable(out));
}

type Measured = {
  golden: Golden[string];
  serialized: Record<string, string>;
  projection: Record<string, Record<string, string>>;
};

async function measure({ name, n, options }: Case): Promise<Measured> {
  const remotes = realisticPortfolio(n + 1, SEED, options);
  const scopeUrls = Object.fromEntries(
    remotes.map(e => [e.name, e.url.replace(/remoteEntry\.json$/, '')])
  );
  const p = portfolio(scopeUrls, {
    hosts: options.host ? [REALISTIC_HOST] : [],
    strict: options.strict,
    storage: `nf-pooling-golden-${name}`,
    realRepositories: true,
    assertNoTear: false,
  });
  const init = {
    importMap: await p.runInit(remotes.slice(0, n)),
    record: structuredClone(p.stored()),
  };
  p.reload();
  const dynamic = await p.runDynamic(structuredClone(remotes[n]!));
  const dynamicRecord = p.stored();

  const serialized = {
    importMap: stable(init.importMap),
    record: stable(init.record),
    delta: stable(dynamic.importMap),
    dynamicRecord: stable(dynamicRecord),
  };
  const islands: Record<string, number> = {};
  for (const external of Object.values(init.record))
    for (const version of external.versions)
      for (const meta of version.remotes) {
        const island = meta.poolCause ?? (meta.servedBy ? 'subpool' : undefined);
        if (island) islands[island] = (islands[island] ?? 0) + 1;
      }
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  return {
    serialized,
    projection: project(dynamic.merged, dynamicRecord, scopeUrls),
    golden: {
      importMap: hash(serialized.importMap),
      record: hash(serialized.record),
      delta: hash(serialized.delta),
      dynamicRecord: hash(serialized.dynamicRecord),
      imports: Object.keys(init.importMap.imports).length,
      scopes: Object.keys(init.importMap.scopes ?? {}).length,
      pooled: Object.values(init.record).filter(e => e.poolName !== undefined).length,
      islands: JSON.parse(stable(islands)),
    },
  };
}

// Writes what a mismatching case produced, so the failure can be diffed rather than only detected.
function dump(name: string, serialized: Record<string, string>): string {
  const dir = join(tmpdir(), 'nf-pooling-golden', name.replace(/[^\w=]+/g, '-'));
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(serialized))
    writeFileSync(join(dir, `${file}.json`), `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  return dir;
}

describe('pooling golden differential', () => {
  const read = (file: string) =>
    !UPDATE && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const golden: Golden = read(FIXTURE);
  const projected: Record<string, Record<string, string>> = read(PROJECTION);
  const measured: Golden = {};
  let projection: Record<string, Record<string, string>> = {};

  afterAll(() => {
    if (!UPDATE) return;
    writeFileSync(FIXTURE, `${JSON.stringify(measured, null, 2)}\n`);
    writeFileSync(PROJECTION, `${JSON.stringify(projection, null, 2)}\n`);
  });

  it('has fixtures to compare against', () => {
    if (UPDATE) return;
    for (const file of [FIXTURE, PROJECTION])
      expect(existsSync(file), `missing ${file}; create it with UPDATE_GOLDEN=1`).toBe(true);
  });

  for (const c of CASES)
    it(`${c.name}: init map, record and dynamic delta match the frozen baseline`, async () => {
      const { golden: hashes, serialized, projection: page } = await measure(c);
      // What each case is there for: the straggler misses for coverage alone, also under strict.
      expect(hashes.islands['uncovered']).toBeGreaterThan(0);
      measured[c.name] = hashes;
      if (c.name === 'N=10') projection = page;
      if (UPDATE) return;
      if (c.name === 'N=10') expect(page).toEqual(projected);
      const matches = JSON.stringify(hashes) === JSON.stringify(golden[c.name]);
      const detail = matches ? '' : ` Serializations written to: ${dump(c.name, serialized)}`;
      expect(hashes, `${c.name} differs from the frozen baseline.${detail}`).toEqual(
        golden[c.name]
      );
    });
});
