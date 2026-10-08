import fc from 'fast-check';
import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';

/**
 * Generated portfolios for the pooling property suite; `portfolio.ts` (`register` with `realRepositories`)
 * runs them. `portfolioArbitrary` is a fast-check arbitrary over small adversarial portfolios (shrinkable spec
 * data, turned into remote entries by `toRemoteEntries`).
 */

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

/**
 * Label noise: the remote labels one member of a pool it ships with another pool's label, which joins the two
 * pools, or with an alias of its own pool's label. Indices are taken modulo what the remote ships.
 */
export type Relabel = { pool: number; member: number; to: number | 'alias' };

export type RemoteSpec = {
  // One per pool: `null` means the remote does not ship that pool at all.
  pools: (RemotePoolSpec | null)[];
  relabel?: Relabel | null;
  // Ships each secondary entrypoint as a package of its own (flat), as a build without
  // `feature.convertFlatSharedInfo` emits it, rather than as an entry of its package (dense).
  flat?: boolean;
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
  // The named share scope every shared external of the portfolio declares; global when absent.
  shareScope?: string;
  // `profile.latestSharedExternal`: round 1 takes the newest build first.
  latestSharedExternal?: boolean;
};

/** What one build ships of a pool: everything a `RemotePoolSpec` says except the range its remote declares. */
type BuildTemplate = Omit<RemotePoolSpec, 'range'>;

const MAJORS = [17, 18];
const RANGES: RangeKind[] = ['caret', 'tilde', 'exact', 'drift', 'major'];

const shapeArbitrary = fc.constantFrom<EntryShape>('root', 'root+sub', 'sub');

const relabelArbitrary: fc.Arbitrary<Relabel> = fc.record({
  pool: fc.nat(),
  member: fc.nat(),
  to: fc.oneof(fc.nat(), fc.constant<'alias'>('alias')),
});

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
 * byte-identical (the subpool tie) and lets a remote join another's subpool. One pool in five is a
 * straggler's build of its own, which keeps ragged one-off families in the mix. `labelNoise` has one remote
 * in five mislabel a member (`Relabel`); off, the portfolios are the ones the seeds have always produced.
 * `flat` has each remote ship flat or dense at random; `shareScope` puts every shared external in that named
 * scope. Both draw nothing when absent, so the default stream is unchanged. `latestSharedExternal` turns the
 * profile flag on or off at random, drawn last, so the portfolio itself is the one the seed draws without it.
 */
export const portfolioArbitrary = (
  o: {
    minRemotes?: number;
    maxRemotes?: number;
    labelNoise?: boolean;
    flat?: boolean;
    shareScope?: string;
    latestSharedExternal?: boolean;
  } = {}
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
              // Opt-in, so existing seeds are unchanged.
              ...(o.labelNoise
                ? {
                    relabel: fc.oneof(
                      { arbitrary: fc.constant(null), weight: 4 },
                      { arbitrary: relabelArbitrary, weight: 1 }
                    ),
                  }
                : {}),
              ...(o.flat ? { flat: fc.boolean() } : {}),
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
          ...(o.latestSharedExternal ? { latest: fc.boolean() } : {}),
        })
        .map(({ templates, remotes, host, mixedMajors, latest }) => ({
          poolSizes,
          strict,
          host,
          ...(o.shareScope === undefined ? {} : { shareScope: o.shareScope }),
          ...(latest === undefined ? {} : { latestSharedExternal: latest }),
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

/**
 * A remote redeployed between two pages: changed by one or two `RedeployChange`s and served from a new URL, so
 * a warm page fetches it again and evicts its old copies.
 */
export type Redeploy = { remote: number; changes: RedeployChange[] };

// A `Mutation`, or one a redeploy adds: `relabel` sets (or with `to: null` clears) the remote's label noise,
// `leave` stops shipping one of its pools.
type RedeployChange = Omit<Mutation, 'kind'> & {
  kind: Mutation['kind'] | 'relabel' | 'leave';
  to: number | 'alias' | null;
};

const redeployChangeArbitrary: fc.Arbitrary<RedeployChange> = fc.record({
  kind: fc.constantFrom<RedeployChange['kind']>(
    'range',
    'strictVersion',
    'patch',
    'drop',
    'add',
    'shape',
    'relabel',
    'leave'
  ),
  pool: fc.nat(),
  member: fc.nat(),
  shape: shapeArbitrary,
  range: fc.constantFrom(...RANGES),
  to: fc.option(fc.oneof(fc.nat(), fc.constant<'alias'>('alias'))),
});

function redeploy(remote: RemoteSpec, c: RedeployChange): RemoteSpec {
  if (c.kind === 'relabel')
    return {
      ...remote,
      relabel: c.to === null ? null : { pool: c.pool, member: c.member, to: c.to },
    };
  if (c.kind === 'leave') {
    const shipped = remote.pools.flatMap((pool, p) => (pool ? [p] : []));
    if (shipped.length === 0) return remote;
    const p = shipped[c.pool % shipped.length]!;
    return { ...remote, pools: remote.pools.map((x, i) => (i === p ? null : x)) };
  }
  return mutate(remote, { ...c, kind: c.kind });
}

/** One to three distinct remotes of `spec` redeployed, each with one or two changes. */
export const redeployArbitrary = (spec: PortfolioSpec): fc.Arbitrary<Redeploy[]> =>
  fc.uniqueArray(
    fc.record({
      remote: fc.nat(spec.remotes.length - 1),
      changes: fc.array(redeployChangeArbitrary, { minLength: 1, maxLength: 2 }),
    }),
    { selector: r => r.remote, minLength: 1, maxLength: Math.min(3, spec.remotes.length) }
  );

// The portfolio after the redeploys: a redeployed remote at its new URL, every other one as it was.
export function redeployedEntries(spec: PortfolioSpec, redeploys: Redeploy[]): RemoteEntry[] {
  return spec.remotes.map((remote, i) => {
    const changes = redeploys.find(r => r.remote === i)?.changes;
    return changes
      ? toRemoteEntry(changes.reduce(redeploy, remote), i, 1, spec.shareScope)
      : toRemoteEntry(remote, i, 0, spec.shareScope);
  });
}

export const remoteName = (index: number): string => `r${index}`;
export const scopeUrlOf = (name: string, deploy = 0): string =>
  deploy === 0 ? `http://${name}/` : `http://${name}/v${deploy}/`;

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

// `deploy` > 0 serves the remote from a new URL (`Redeploy`).
export function toRemoteEntry(
  spec: RemoteSpec,
  index: number,
  deploy = 0,
  shareScope?: string
): RemoteEntry {
  const name = remoteName(index);
  const shared: DenseSharedInfo[] = [];
  const shipped = spec.pools.flatMap((pool, p) => (pool ? [p] : []));
  const relabelled =
    spec.relabel && shipped.length > 0 ? shipped[spec.relabel.pool % shipped.length] : -1;

  spec.pools.forEach((pool, p) => {
    if (!pool) return;
    // A remote that ships a pool ships at least its first present member; an all-empty row means member 0.
    const members = pool.members.some(m => m !== null)
      ? pool.members
      : pool.members.map((_, i) => (i === 0 ? 'root' : null));
    const present = members.flatMap((shape, m) => (shape === null ? [] : [m]));
    const noisy = p === relabelled ? present[spec.relabel!.member % present.length] : undefined;
    const labelOf = (m: number) => {
      if (m !== noisy) return `p${p}`;
      const to = spec.relabel!.to;
      return to === 'alias' ? `p${p}-alias` : `p${to % spec.pools.length}`;
    };
    members.forEach((shape, m) => {
      if (shape === null) return;
      const pkg = memberName(p, m);
      const entries: Record<string, string> = {};
      if (shape !== 'sub') entries[pkg] = `${pkg.slice(1).replace('/', '_')}.js`;
      if (shape !== 'root') entries[`${pkg}/sub`] = `${pkg.slice(1).replace('/', '_')}_sub.js`;
      const info = (packageName: string, entries: Record<string, string>) =>
        shared.push({
          packageName,
          version: versionOf(pool),
          requiredVersion: rangeOf(pool),
          singleton: true,
          strictVersion: spec.strictVersion,
          pool: labelOf(m),
          ...(shareScope === undefined ? {} : { shareScope }),
          entries,
        } as DenseSharedInfo);
      if (!spec.flat) return void info(pkg, entries);
      for (const [specifier, file] of Object.entries(entries))
        info(specifier, { [specifier]: file });
    });
  });

  if (spec.extra !== null) {
    shared.push({
      packageName: 'extra',
      version: `1.${spec.extra}.0`,
      requiredVersion: spec.extraRange === 'caret' ? '^1.0.0' : `~1.${spec.extra}.0`,
      singleton: true,
      strictVersion: spec.strictVersion,
      ...(shareScope === undefined ? {} : { shareScope }),
      entries: { extra: 'extra.js' },
    } as DenseSharedInfo);
  }

  return {
    name,
    url: `${scopeUrlOf(name, deploy)}remoteEntry.json`,
    exposes: [],
    shared,
  } as unknown as RemoteEntry;
}

export const toRemoteEntries = (spec: PortfolioSpec): RemoteEntry[] =>
  spec.remotes.map((remote, i) => toRemoteEntry(remote, i, 0, spec.shareScope));

export const hostOf = (spec: PortfolioSpec): string | undefined =>
  spec.host === null ? undefined : remoteName(spec.host % spec.remotes.length);
