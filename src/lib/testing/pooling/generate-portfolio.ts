import fc from 'fast-check';
import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';
import { tagSharedInfoByNpmScope } from './tag-by-npm-scope';

/**
 * Generated portfolios for the pooling property suite and the golden differential test; `portfolio.ts`
 * (`register` with `realRepositories`) runs them.
 *
 * Two generators:
 * - `portfolioArbitrary`: a fast-check arbitrary over small adversarial portfolios (shrinkable spec data,
 *   turned into remote entries by `toRemoteEntries`).
 * - `realisticPortfolio`: a seeded, deterministic portfolio shaped like a real Angular estate.
 */

// ---------------------------------------------------------------------------------------------------------
// Adversarial portfolios (fast-check)
// ---------------------------------------------------------------------------------------------------------

/**
 * How one remote declares the range of a pool it ships. `drift` excludes its own tag; `major` is the
 * `^<major>.0.0` a framework emits by default, the range that accepts most of a portfolio.
 */
export type RangeKind = 'caret' | 'tilde' | 'exact' | 'drift' | 'major';

/** Which entrypoints a remote ships of one member. */
export type EntryShape = 'root' | 'root+sub' | 'sub';

export type RemotePoolSpec = {
  major: number;
  minor: number;
  patch: number;
  // A prerelease of that tag (`-rc.<pre>`): a caret or major range accepts it only from the same triple.
  pre?: number;
  range: RangeKind;
  // One per member of the pool: `null` leaves the member out (a ragged family).
  members: (EntryShape | null)[];
};

export type RemoteSpec = {
  // One per pool: `null` means the remote does not ship that pool at all.
  pools: (RemotePoolSpec | null)[];
  strictVersion: boolean;
  // An unpooled singleton beside the pools, at one of two minors.
  extra: number | null;
  // Its range: `~1.<minor>.0` (the default) rejects the other minor, `^1.0.0` accepts both.
  extraRange?: 'tilde' | 'caret';
};

export type PortfolioSpec = {
  poolSizes: number[];
  remotes: RemoteSpec[];
  // Index into `remotes`; resolved modulo its length.
  host: number | null;
  strict: boolean;
};

/** What one build ships of a pool: everything a `RemotePoolSpec` says except the range its remote declares. */
type BuildTemplate = Omit<RemotePoolSpec, 'range'>;

const MAJORS = [17, 18];
const RANGES: RangeKind[] = ['caret', 'tilde', 'exact', 'drift', 'major'];

const shapeArbitrary = fc.constantFrom<EntryShape>('root', 'root+sub', 'sub');

const templateArbitrary = (size: number): fc.Arbitrary<BuildTemplate> =>
  fc
    .record({
      major: fc.integer({ min: 0, max: MAJORS.length - 1 }),
      minor: fc.integer({ min: 0, max: 2 }),
      patch: fc.integer({ min: 0, max: 1 }),
      // Rare: a prerelease is an outlier most ranges reject.
      pre: fc.oneof(
        { arbitrary: fc.constant(null), weight: 9 },
        { arbitrary: fc.integer({ min: 0, max: 1 }), weight: 1 }
      ),
      members: fc.array(fc.option(shapeArbitrary, { freq: 4 }), {
        minLength: size,
        maxLength: size,
      }),
    })
    .map(({ pre, ...template }) => (pre === null ? template : { ...template, pre }));

// Under `strictExternalCompatibility` mostly ranges that accept the rest of their major: with uniform ranges
// ~80% of strict portfolios were refused outright, and a refused portfolio skips every other property.
const rangeArbitrary = (strict: boolean): fc.Arbitrary<RangeKind> =>
  strict
    ? fc.oneof(
        { arbitrary: fc.constant<RangeKind>('major'), weight: 16 },
        { arbitrary: fc.constant<RangeKind>('caret'), weight: 2 },
        { arbitrary: fc.constantFrom<RangeKind>('tilde', 'exact', 'drift'), weight: 1 }
      )
    : fc.constantFrom(...RANGES);

const freshPoolArbitrary = (size: number, strict = false): fc.Arbitrary<RemotePoolSpec> =>
  fc
    .tuple(templateArbitrary(size), rangeArbitrary(strict))
    .map(([template, range]) => ({ ...template, range }));

// A remote whose every pool is its own build, unrelated to anyone else's.
const freshRemoteArbitrary = (poolSizes: number[]): fc.Arbitrary<RemoteSpec> =>
  fc.record({
    pools: fc.tuple(...poolSizes.map(size => fc.option(freshPoolArbitrary(size), { freq: 5 }))),
    strictVersion: fc.boolean(),
    extra: fc.option(fc.integer({ min: 0, max: 1 })),
  });

/**
 * Each pool has 2-4 builds and a remote that ships the pool mostly runs one of them, declaring its own range
 * and `strictVersion`: real portfolios deploy a few builds many times, which is what makes builds
 * byte-identical (the subpool tie, D10) and lets a remote join another's subpool. One pool in five is a
 * straggler's build of its own, which keeps ragged one-off families in the mix.
 */
export const portfolioArbitrary = (
  o: { minRemotes?: number; maxRemotes?: number } = {}
): fc.Arbitrary<PortfolioSpec> =>
  fc
    .record({
      poolSizes: fc.array(fc.integer({ min: 2, max: 6 }), { minLength: 1, maxLength: 3 }),
      strict: fc.boolean(),
    })
    .chain(({ poolSizes, strict }) =>
      fc
        .record({
          templates: fc.tuple(
            ...poolSizes.map(size =>
              fc.array(templateArbitrary(size), { minLength: 2, maxLength: 4 })
            )
          ),
          remotes: fc.array(
            fc.record({
              pools: fc.tuple(
                ...poolSizes.map(size =>
                  fc.option(
                    fc.oneof(
                      {
                        arbitrary: fc.record({ build: fc.nat(3), range: rangeArbitrary(strict) }),
                        weight: 4,
                      },
                      // A straggler: a build only this remote ships.
                      { arbitrary: freshPoolArbitrary(size, strict), weight: 1 }
                    ),
                    { freq: 5 }
                  )
                )
              ),
              strictVersion: fc.boolean(),
              extra: fc.option(fc.integer({ min: 0, max: 1 })),
              // The unpooled extra is the resolver's to refuse, so it gets the same bias.
              extraRange: strict
                ? fc.oneof(
                    { arbitrary: fc.constant<'caret'>('caret'), weight: 9 },
                    { arbitrary: fc.constant<'tilde'>('tilde'), weight: 1 }
                  )
                : fc.constant<'tilde'>('tilde'),
            }),
            { minLength: o.minRemotes ?? 1, maxLength: o.maxRemotes ?? 20 }
          ),
          host: fc.option(fc.nat()),
          // Under strict, a pool's builds mostly stay on one major line, which a `major` range accepts whole.
          mixedMajors: fc.tuple(
            ...poolSizes.map(() =>
              strict ? fc.integer({ min: 0, max: 3 }).map(n => n === 0) : fc.constant(true)
            )
          ),
        })
        .map(({ templates, remotes, host, mixedMajors }) => ({
          poolSizes,
          strict,
          host,
          remotes: remotes.map(remote => ({
            ...remote,
            pools: remote.pools.map((pick, p) => {
              if (pick === null) return null;
              const builds = templates[p]!;
              const pool =
                'build' in pick
                  ? { ...builds[pick.build % builds.length]!, range: pick.range }
                  : pick;
              return mixedMajors[p] ? pool : { ...pool, major: builds[0]!.major };
            }),
          })),
        }))
    );

type Mutation = {
  kind: 'range' | 'strictVersion' | 'patch' | 'drop' | 'add' | 'shape';
  pool: number;
  member: number;
  shape: EntryShape;
  range: RangeKind;
};

const mutationArbitrary: fc.Arbitrary<Mutation> = fc.record({
  kind: fc.constantFrom<Mutation['kind']>(
    'range',
    'strictVersion',
    'patch',
    'drop',
    'add',
    'shape'
  ),
  pool: fc.nat(),
  member: fc.nat(),
  shape: shapeArbitrary,
  range: fc.constantFrom(...RANGES),
});

// One change to a remote: its range or strictness, another patch of its build, or one member or entrypoint
// set more or less. Indices are taken modulo what the remote ships.
function mutate(remote: RemoteSpec, m: Mutation): RemoteSpec {
  const shipped = remote.pools.flatMap((pool, p) => (pool ? [p] : []));
  if (m.kind === 'strictVersion' || shipped.length === 0)
    return { ...remote, strictVersion: !remote.strictVersion };

  const p = shipped[m.pool % shipped.length]!;
  const pool = remote.pools[p]!;
  const member = m.member % pool.members.length;
  const edit = (shape: EntryShape | null): EntryShape | null =>
    m.kind === 'drop' ? null : m.kind === 'add' ? (shape ?? m.shape) : m.shape;
  const changed: RemotePoolSpec =
    m.kind === 'range'
      ? { ...pool, range: m.range }
      : m.kind === 'patch'
        ? { ...pool, patch: 1 - pool.patch }
        : {
            ...pool,
            members: pool.members.map((shape, i) => (i === member ? edit(shape) : shape)),
          };
  return { ...remote, pools: remote.pools.map((x, i) => (i === p ? changed : x)) };
}

// A copy of one of `sources`, as is or with one mutation.
const derivedRemoteArbitrary = (sources: RemoteSpec[]): fc.Arbitrary<RemoteSpec> => {
  const clone = fc.nat(sources.length - 1).map(i => sources[i]!);
  return fc.oneof(
    clone,
    fc.tuple(clone, mutationArbitrary).map(([remote, m]) => mutate(remote, m))
  );
};

/**
 * One more remote for an existing spec, for the dynamic path: a redeploy of a remote the page has (a clone),
 * the same remote one change later, or a remote with builds of its own.
 */
export const extraRemoteArbitrary = (spec: PortfolioSpec): fc.Arbitrary<RemoteSpec> =>
  spec.remotes.length === 0
    ? freshRemoteArbitrary(spec.poolSizes)
    : fc.oneof(
        { arbitrary: derivedRemoteArbitrary(spec.remotes), weight: 2 },
        { arbitrary: freshRemoteArbitrary(spec.poolSizes), weight: 1 }
      );

/**
 * One or two remotes loaded one after the other. The second is often derived from the first, so it can join
 * a subpool the first load created.
 */
export const extraRemotesArbitrary = (spec: PortfolioSpec): fc.Arbitrary<RemoteSpec[]> =>
  extraRemoteArbitrary(spec).chain(first =>
    fc
      .option(
        fc.oneof(
          derivedRemoteArbitrary([first]),
          extraRemoteArbitrary({ ...spec, remotes: [...spec.remotes, first] })
        ),
        { freq: 2 }
      )
      .map(second => (second === null ? [first] : [first, second]))
  );

export const remoteName = (index: number): string => `r${index}`;
export const scopeUrlOf = (name: string): string => `http://${name}/`;

const versionOf = (p: RemotePoolSpec) =>
  `${MAJORS[p.major]!}.${p.minor}.${p.patch}${p.pre === undefined ? '' : `-rc.${p.pre}`}`;

function rangeOf(p: RemotePoolSpec): string {
  const tag = versionOf(p);
  switch (p.range) {
    case 'caret':
      return `^${tag}`;
    case 'tilde':
      return `~${tag}`;
    case 'exact':
      return tag;
    case 'drift':
      // A range that was never bumped with the lockfile: it excludes the very tag this remote ships.
      return `~${MAJORS[p.major]!}.${(p.minor + 1) % 3}.0`;
    case 'major':
      return `^${MAJORS[p.major]!}.0.0`;
  }
}

export const memberName = (pool: number, member: number): string => `@p${pool}/m${member}`;

export function toRemoteEntry(spec: RemoteSpec, index: number): RemoteEntry {
  const name = remoteName(index);
  const shared: DenseSharedInfo[] = [];

  spec.pools.forEach((pool, p) => {
    if (!pool) return;
    // A remote that ships a pool ships at least its first present member; an all-empty row means member 0.
    const members = pool.members.some(m => m !== null)
      ? pool.members
      : pool.members.map((_, i) => (i === 0 ? 'root' : null));
    members.forEach((shape, m) => {
      if (shape === null) return;
      const pkg = memberName(p, m);
      const entries: Record<string, string> = {};
      if (shape !== 'sub') entries[pkg] = `${pkg.slice(1).replace('/', '_')}.js`;
      if (shape !== 'root') entries[`${pkg}/sub`] = `${pkg.slice(1).replace('/', '_')}_sub.js`;
      shared.push({
        packageName: pkg,
        version: versionOf(pool),
        requiredVersion: rangeOf(pool),
        singleton: true,
        strictVersion: spec.strictVersion,
        pool: `p${p}`,
        entries,
      } as DenseSharedInfo);
    });
  });

  if (spec.extra !== null) {
    shared.push({
      packageName: 'extra',
      version: `1.${spec.extra}.0`,
      requiredVersion: spec.extraRange === 'caret' ? '^1.0.0' : `~1.${spec.extra}.0`,
      singleton: true,
      strictVersion: spec.strictVersion,
      entries: { extra: 'extra.js' },
    } as DenseSharedInfo);
  }

  return {
    name,
    url: `${scopeUrlOf(name)}remoteEntry.json`,
    exposes: [],
    shared,
  } as unknown as RemoteEntry;
}

export const toRemoteEntries = (spec: PortfolioSpec): RemoteEntry[] =>
  spec.remotes.map(toRemoteEntry);

export const hostOf = (spec: PortfolioSpec): string | undefined =>
  spec.host === null ? undefined : remoteName(spec.host % spec.remotes.length);

// ---------------------------------------------------------------------------------------------------------
// Realistic portfolios (seeded)
// ---------------------------------------------------------------------------------------------------------

type AngularBuild = { ng: string; cdk: string };

// Weighted like a portfolio mid-upgrade: two patch builds of the current line, one major behind, a straggler.
const ANGULAR_BUILDS: [AngularBuild, number][] = [
  [{ ng: '19.2.15', cdk: '19.2.18' }, 40],
  [{ ng: '19.2.14', cdk: '19.2.17' }, 25],
  [{ ng: '18.2.13', cdk: '18.2.14' }, 25],
  [{ ng: '17.3.12', cdk: '17.3.10' }, 10],
];

// The host runs the build a patch behind the majority's, so host precedence decides round 1.
const HOST_BUILD = ANGULAR_BUILDS[1]![0];

// A build only one remote ships, on the current major, with an entrypoint no other build ships.
const STRAGGLER_BUILD: AngularBuild = { ng: '19.1.3', cdk: '19.1.2' };

export type RealisticOptions = {
  /** `team/mfe-0` is the host, on the build a patch behind the majority's. */
  host?: boolean;
  /**
   * `team/straggler`, in the middle, ships a partial family of a build of its own with ranges that accept the
   * whole major, plus `@angular/core/testing` that no other build ships: it misses only for coverage.
   */
  straggler?: boolean;
  /**
   * A portfolio `strictExternalCompatibility` accepts: Angular on the current major only, one `@ngrx` version,
   * and every range accepting its whole major, as builds emit by default.
   */
  strict?: boolean;
};

export const REALISTIC_HOST = 'team/mfe-0';

// Linear congruential generator: the golden test needs the same portfolio on every platform and run.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

function entriesOf(pkg: string, subs: string[]): Record<string, string> {
  return Object.fromEntries(
    [pkg, ...subs.map(s => `${pkg}/${s}`)].map(s => [s, `${s.replace(/[@/]/g, '_')}.js`])
  );
}

function shared(
  packageName: string,
  version: string,
  requiredVersion: string,
  entries: Record<string, string>,
  o: Partial<DenseSharedInfo> = {}
): DenseSharedInfo {
  return {
    packageName,
    version,
    requiredVersion,
    singleton: true,
    strictVersion: true,
    entries,
    ...o,
  } as DenseSharedInfo;
}

/**
 * `n` remotes, each with ~15-25 externals: an `@angular/*` family of up to ten members labelled `angular`
 * (2-4 builds across three majors; 30% ship a partial family, 20% drop entrypoints, material ships
 * entrypoints only), `@ngrx/*` and `@company/*` pools labelled by npm scope, rxjs/tslib and unpooled libs.
 */
export function realisticPortfolio(
  n: number,
  seed: number,
  o: RealisticOptions = {}
): RemoteEntry[] {
  const random = seededRandom(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
  const weighted = <T>(xs: [T, number][]): T => {
    let r = random() * xs.reduce((s, [, w]) => s + w, 0);
    for (const [x, w] of xs) if ((r -= w) <= 0) return x;
    return xs[xs.length - 1]![0];
  };
  const builds = o.strict ? ANGULAR_BUILDS.filter(([b]) => b.ng.startsWith('19.')) : ANGULAR_BUILDS;
  const range = (version: string) => (o.strict ? `^${version.split('.')[0]!}.0.0` : `^${version}`);

  const angular = (b: AngularBuild): DenseSharedInfo[] => {
    const partial = random() < 0.3;
    const dropEntries = random() < 0.2;
    const ng = (p: string, subs: string[] = []) =>
      shared(`@angular/${p}`, b.ng, range(b.ng), entriesOf(`@angular/${p}`, subs), {
        pool: 'angular',
      });
    const family = [
      ng('core', dropEntries ? [] : ['rxjs-interop', 'primitives/signals']),
      ng('common', dropEntries ? [] : ['http']),
      ng('compiler'),
      ng('router'),
      ng('platform-browser', ['animations']),
      ng('platform-browser-dynamic'),
    ];
    if (!partial || random() < 0.5) family.push(ng('forms'));
    if (!partial || random() < 0.5) family.push(ng('animations', ['browser']));
    family.push(
      shared(
        '@angular/cdk',
        b.cdk,
        range(b.cdk),
        entriesOf('@angular/cdk', dropEntries ? ['a11y', 'portal'] : ['a11y', 'overlay', 'portal']),
        { pool: 'angular' }
      )
    );
    if (!partial || random() < 0.5) {
      const subs = ['button', 'dialog', 'table'].filter(() => !dropEntries || random() < 0.6);
      family.push(
        shared(
          '@angular/material',
          b.cdk,
          range(b.cdk),
          Object.fromEntries(
            subs.map(s => [`@angular/material/${s}`, `_angular_material_${s}.js`])
          ),
          { pool: 'angular' }
        )
      );
    }
    return family;
  };

  const straggler = (): DenseSharedInfo[] => {
    const b = STRAGGLER_BUILD;
    const ng = (p: string, subs: string[] = []) =>
      shared(
        `@angular/${p}`,
        b.ng,
        `^${b.ng.split('.')[0]!}.0.0`,
        entriesOf(`@angular/${p}`, subs),
        {
          pool: 'angular',
          strictVersion: false,
        }
      );
    return [
      ng('core', ['testing']),
      ng('common'),
      ng('router'),
      shared(
        '@angular/cdk',
        b.cdk,
        `^${b.cdk.split('.')[0]!}.0.0`,
        entriesOf('@angular/cdk', ['a11y']),
        {
          pool: 'angular',
          strictVersion: false,
        }
      ),
    ];
  };

  const others = (): DenseSharedInfo[] => {
    const out = [
      shared('rxjs', pick(['7.8.1', '7.8.2']), '~7.8.0', entriesOf('rxjs', ['operators'])),
      shared('tslib', pick(['2.6.2', '2.8.1']), '^2.3.0', entriesOf('tslib', [])),
    ];
    if (random() < 0.6) {
      const v = o.strict ? '19.0.0' : pick(['18.0.2', '19.0.0']);
      out.push(shared('@ngrx/store', v, range(v), entriesOf('@ngrx/store', [])));
      out.push(shared('@ngrx/effects', v, range(v), entriesOf('@ngrx/effects', [])));
    }
    if (random() < 0.7) {
      const v = pick(o.strict ? ['3.1.0', '3.2.0'] : ['3.1.0', '3.2.0', '4.0.0']);
      out.push(shared('@company/ui', v, range(v), entriesOf('@company/ui', ['icons'])));
      out.push(shared('@company/utils', v, range(v), entriesOf('@company/utils', [])));
    }
    const count = 3 + Math.floor(random() * 6);
    const libs = new Set<number>();
    while (libs.size < count) libs.add(Math.floor(random() * 20));
    for (const i of [...libs].sort((a, b) => a - b)) {
      const major = 1 + (i % 3);
      const v = `${major}.${Math.floor(random() * 3)}.${Math.floor(random() * 4)}`;
      out.push(
        shared(`lib-${i}`, v, `^${major}.0.0`, entriesOf(`lib-${i}`, []), {
          singleton: random() < 0.7,
        })
      );
    }
    return out;
  };

  const stragglerAt = o.straggler ? Math.floor(n / 2) : -1;
  return Array.from({ length: n }, (_, i) => {
    const name = i === stragglerAt ? 'team/straggler' : `team/mfe-${i}`;
    const family =
      i === stragglerAt ? straggler() : angular(o.host && i === 0 ? HOST_BUILD : weighted(builds));
    return {
      name,
      url: `http://${name.slice('team/'.length)}/remoteEntry.json`,
      exposes: [{ key: './Component', outFileName: 'component.js' }],
      shared: tagSharedInfoByNpmScope([...family, ...others()]),
    } as unknown as RemoteEntry;
  });
}
