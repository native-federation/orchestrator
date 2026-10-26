import type { ImportMap, RemoteEntry, RemoteSharedInfo, shareScope } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';
import { pageTears, type ImportsOf } from 'lib/testing/pooling/page-graph';
import { packageOfIn } from 'lib/core/1.domain/externals/specifier';

/**
 * Libraries a `'paths'` build publishes as dense externals of their own (`@s/c/t`, `@s/c/u`) are packages of
 * their own, through init, pooling, a runtime load and the next page. The test provider hands entries over as
 * intake leaves them, so `dense` is set here. Every page runs the portfolio's no-tear oracle, which groups by
 * what each build bundled, not by the rule under test.
 */

let storage = 0;

const url = (remote: string) => `http://${remote}/`;
const file = (s: string) => `${s.replace(/^@/, '').replace(/\//g, '_')}.js`;

// One library as a `'paths'` build publishes it, or (`dense: false`) as an older core's flat entry. `strict` pins
// that version with a strict `~` range.
const lib = (
  name: string,
  o: { with?: string[]; pool?: string; dense?: boolean; version?: string; strict?: string } = {}
): RemoteSharedInfo => ({
  packageName: name,
  version: o.strict ?? o.version ?? '1.0.0',
  requiredVersion: o.strict ? `~${o.strict}` : '^1.0.0',
  singleton: true,
  strictVersion: o.strict !== undefined,
  ...(o.pool ? { pool: o.pool } : {}),
  ...((o.dense ?? true) ? { dense: true as const } : {}),
  entries: Object.fromEntries([name, ...(o.with ?? [])].map(s => [s, file(s)])),
});

const entry = (name: string, ...shared: RemoteSharedInfo[]): RemoteEntry =>
  ({ name, url: `${url(name)}remoteEntry.json`, exposes: [], shared }) as unknown as RemoteEntry;

const fresh = (hosts: string[] = [], assertNoTear = true) =>
  portfolio(
    {},
    { storage: `nf-declared-packages-${storage++}`, realRepositories: true, hosts, assertNoTear }
  );

const at = (remote: string, specifier: string) => `${url(remote)}${file(specifier)}`;
const scopeOf = (map: ImportMap, remote: string) => map.scopes?.[url(remote)] ?? {};

// Each stored copy's `dense` mark, so a rewrite that drops it shows.
const marks = (record: shareScope) =>
  Object.entries(record).flatMap(([name, external]) =>
    external.versions.flatMap(v => v.remotes.map(r => `${name}|${r.name}|${r.dense ?? false}`))
  );

describe('dense libraries deeper than an npm name', () => {
  // The shell imports `@s/c/t` only. Under the npm-name rule `@s/c` is one package the shell serves without
  // `@s/c/u`, so mfe runs both libraries from its own build.
  const shell = () => entry('shell', lib('@s/c/t'));
  const mfe = (dense = true) => entry('mfe', lib('@s/c/t', { dense }), lib('@s/c/u', { dense }));

  it('serves a library the shell does not import without scoping the one it does', async () => {
    const p = fresh(['shell']);
    const map = await p.runInit([shell(), mfe()]);

    expect(map.imports['@s/c/t']).toBe(at('shell', '@s/c/t'));
    expect(map.imports['@s/c/u']).toBe(at('mfe', '@s/c/u'));
    expect(scopeOf(map, 'mfe')).toEqual({});

    p.reload();
    expect(await p.runInit([shell(), mfe()])).toEqual(map);
  });

  it('keeps the npm-name grouping for an older flat build', async () => {
    const map = await fresh(['shell']).runInit([shell(), mfe(false)]);

    expect(map.imports['@s/c/u']).toBeUndefined();
    expect(scopeOf(map, 'mfe')).toEqual({
      '@s/c/t': at('mfe', '@s/c/t'),
      '@s/c/u': at('mfe', '@s/c/u'),
    });
  });

  it("extends a pool label to the library it is on, not to the library's npm name", async () => {
    const p = fresh(['shell']);
    const labelled = (name: string, ...shared: RemoteSharedInfo[]) =>
      entry(name, lib('@s/fw', { pool: 'ui' }), ...shared);
    const map = await p.runInit([
      labelled('shell', lib('@s/c/t', { pool: 'ui' })),
      labelled('mfe', lib('@s/c/t', { pool: 'ui' }), lib('@s/c/u')),
    ]);

    expect(p.record('@s/c/t').poolName).toBe('ui');
    expect(p.record('@s/c/u').poolName).toBeUndefined();
    expect(map.imports['@s/c/u']).toBe(at('mfe', '@s/c/u'));
    expect(scopeOf(map, 'mfe')).toEqual({});
    expect(marks(p.stored()).every(m => m.endsWith('|true'))).toBe(true);

    // A load the gate serves itself: its moved copies keep their mark too.
    await p.runDynamic(
      entry('late', lib('@s/fw', { pool: 'ui', strict: '2.0.0' }), lib('@s/c/t', { pool: 'ui' }))
    );
    expect(p.islands('ui')).toEqual({ late: 'incompatible' });
    expect(marks(p.stored()).every(m => m.endsWith('|true'))).toBe(true);
  });

  it('publishes a pooled library the winner lacks beside another library under its npm name', async () => {
    // mfe ships `@s/c/u` at another version than `@s/c/t`: two libraries, not one package at two tags.
    const p = fresh(['shell']);
    const map = await p.runInit([
      entry('shell', lib('@s/fw', { pool: 'ui' }), lib('@s/c/t', { pool: 'ui' })),
      entry(
        'mfe',
        lib('@s/fw', { pool: 'ui' }),
        lib('@s/c/t', { pool: 'ui' }),
        lib('@s/c/u', { pool: 'ui', version: '1.2.0' })
      ),
    ]);

    expect(p.islands('ui')).toEqual({});
    expect(map.imports['@s/c/u']).toBe(at('mfe', '@s/c/u'));
    expect(scopeOf(map, 'mfe')).toEqual({});
  });

  it('lets a load take a pooled library the map does not serve beside one it does', async () => {
    const p = fresh(['shell']);
    const pooled = (name: string, ...libs: string[]) =>
      entry(name, ...libs.map(l => lib(l, { pool: 'ui' })));
    await p.runInit([pooled('shell', '@s/fw', '@s/c/t'), pooled('mfe', '@s/fw', '@s/c/t')]);
    const { merged } = await p.runDynamic(pooled('late', '@s/fw', '@s/c/t', '@s/c/u'));

    expect(p.islands('ui')).toEqual({});
    expect(merged.imports['@s/c/u']).toBe(at('late', '@s/c/u'));
    expect(scopeOf(merged, 'late')).toEqual({});
  });

  it('serves a pooled load itself when it ships an entrypoint of a library the map serves only in part', async () => {
    // late ships `@s/c/t/x` alone: the map serves `@s/c/t` from the shell, so taking x from late's own build
    // beside the shell's root would split the library. Its npm name `@s/c` must not decide that gap.
    const p = fresh(['shell']);
    const pooled = (name: string, ...shared: RemoteSharedInfo[]) =>
      entry(name, lib('@s/fw', { pool: 'ui' }), ...shared);
    await p.runInit([pooled('shell', lib('@s/c/t', { pool: 'ui' }))]);
    await p.runDynamic(
      pooled('late', {
        ...lib('@s/c/t', { pool: 'ui' }),
        entries: { '@s/c/t/x': file('@s/c/t/x') },
      })
    );

    expect(p.islands('ui')).toEqual({ late: 'uncovered' });
  });

  it('opens a library the map does not serve on a load, following the shell for the one it does', async () => {
    const p = fresh(['shell']);
    await p.runInit([shell()]);
    const { actions, merged } = await p.runDynamic(mfe());

    expect(actions['@s/c/t']!.action).toBe('skip');
    expect(actions['@s/c/u']!.action).toBe('share');
    expect(merged.imports['@s/c/u']).toBe(at('mfe', '@s/c/u'));
    expect(scopeOf(merged, 'mfe')).toEqual({});
  });

  it('runs an older build that bundles both libraries from its own build over a page that serves them apart', async () => {
    const p = fresh(['shell']);
    const committed = await p.runInit([shell(), mfe()]);
    const old = entry('old', lib('@s/c', { with: ['@s/c/t', '@s/c/u'] }));
    const { actions, importMap } = await p.runDynamic(old);

    // The committed map serves `@s/c/t` and `@s/c/u` from two builds; old's one bundle cannot follow both.
    expect(actions['@s/c']!.action).toBe('scope');
    expect(importMap.imports).toEqual({});
    expect(scopeOf(importMap, 'old')).toEqual({
      '@s/c': at('old', '@s/c'),
      '@s/c/t': at('old', '@s/c/t'),
      '@s/c/u': at('old', '@s/c/u'),
    });

    // The next page groups `@s/c` by the npm name, as 4.8.0 did.
    p.reload();
    const next = await p.runInit([shell(), mfe(), old]);
    expect(next).not.toEqual(committed);
    expect(next.imports['@s/c/t']).toBe(at('shell', '@s/c/t'));
    expect(next.imports['@s/c/u']).toBeUndefined();
  });
});

describe('dense records that share a specifier', () => {
  const T = '@s/c/t';
  const SORT = '@s/c/t/sort';
  const U = '@s/c/u';
  const Y = '@s/c/u/y';

  // What a library's files import, as real code does: the library it is nested in, and the npm root. Only where
  // the build ships that import, so a generated file never imports what its own build lacks. The portfolio's
  // tag-based oracle cannot see a cross-package import; `pageTears` follows these edges from where each file
  // lives, so a nested library served apart from the one it imports shows as two instances.
  const NESTED: Record<string, string> = { [SORT]: T, [`${SORT}/x`]: SORT, [Y]: U, [T]: '@s/c' };
  const importsIn =
    (entries: RemoteEntry[], edges: Record<string, string>): ImportsOf =>
    (build, specifier) => {
      const up = edges[specifier];
      const ships = entries.find(e => e.name === build)?.shared.some(i => up! in i.entries);
      return up !== undefined && ships ? [up] : [];
    };

  // The page at init, and the page where the last remote loads at runtime over the others' init. Both must run
  // every library once per remote.
  async function pages(
    entries: RemoteEntry[],
    o: { edges?: Record<string, string>; assertNoTear?: boolean } = {}
  ) {
    const importsOf = importsIn(entries, o.edges ?? NESTED);
    const tears = (importMap: ImportMap) =>
      pageTears({ importMap, entries, hosts: ['shell'], importsOf });

    const p = fresh(['shell'], o.assertNoTear);
    const init = await p.runInit(entries);
    expect(tears(init)).toEqual([]);

    const q = fresh(['shell'], o.assertNoTear);
    await q.runInit(entries.slice(0, -1));
    const load = await q.runDynamic(entries.at(-1)!);
    expect(tears(load.merged)).toEqual([]);

    const packageOf = packageOfIn(p.stored());
    const packages = (...specifiers: string[]) =>
      Object.fromEntries(specifiers.map(s => [s, packageOf(s)]));
    return { p, init, load, packages };
  }

  it('serves nested libraries exact keys publish apart as packages of their own', async () => {
    // Exact `paths` keys: `t` and `t/sort` are two dense records, so two packages, as `u` and `u/y` are.
    const { init, load, packages } = await pages([
      entry('shell', lib(T), lib(SORT)),
      entry('mfe', lib(T), lib(SORT), lib(U), lib(Y)),
    ]);

    expect(packages(T, SORT, U, Y)).toEqual({ [T]: T, [SORT]: SORT, [U]: U, [Y]: Y });
    expect(init.imports).toEqual({
      [T]: at('shell', T),
      [SORT]: at('shell', SORT),
      [U]: at('mfe', U),
      [Y]: at('mfe', Y),
    });
    expect(init.scopes ?? {}).toEqual({});

    expect(load.actions[T]!.action).toBe('skip');
    expect(load.actions[SORT]!.action).toBe('skip');
    expect(load.actions[U]!.action).toBe('share');
    expect(load.merged.scopes ?? {}).toEqual({});
  });

  it('merges a record that lists another library with that library, however the other build keys it', async () => {
    // The shell's `.package()` (or wildcard) record lists `t/sort`; mfe keys it apart. One package, named `t`.
    const { init, load, packages } = await pages([
      entry('shell', lib(T, { with: [SORT] })),
      entry('mfe', lib(T), lib(SORT), lib(U)),
    ]);

    expect(packages(T, SORT, U)).toEqual({ [T]: T, [SORT]: T, [U]: U });
    expect(init.imports).toEqual({
      [T]: at('shell', T),
      [SORT]: at('shell', SORT),
      [U]: at('mfe', U),
    });
    expect(init.scopes ?? {}).toEqual({});
    expect(load.merged.scopes ?? {}).toEqual({});
  });

  it('keeps a family a build migrates to `.package()` together over builds that still key it apart', async () => {
    const { init, load, packages } = await pages([
      entry('shell', lib(T), lib(SORT)),
      entry('mfe2', lib(U)),
      entry('mfe', lib(T, { with: [SORT] })),
    ]);

    expect(packages(T, SORT, U)).toEqual({ [T]: T, [SORT]: T, [U]: U });
    expect(init.imports).toEqual({
      [T]: at('shell', T),
      [SORT]: at('shell', SORT),
      [U]: at('mfe2', U),
    });
    expect(init.scopes ?? {}).toEqual({});
    expect(load.actions[T]!.action).toBe('skip');
    expect(load.merged.scopes ?? {}).toEqual({});
  });

  it('merges through a library two records share, down to the one nested deepest', async () => {
    // The shell's `t` record lists `t/sort`; mfe's `t/sort` record lists `t/sort/x`. The shell's build lacks x, so
    // mfe runs its part of the family from its own build, over the shell's `t`.
    const X = `${SORT}/x`;
    const { init, load, packages } = await pages([
      entry('shell', lib(T, { with: [SORT] })),
      entry('mfe', lib(SORT, { with: [X] })),
    ]);

    expect(packages(T, SORT, X)).toEqual({ [T]: T, [SORT]: T, [X]: T });
    expect(init.imports).toEqual({ [T]: at('shell', T), [SORT]: at('shell', SORT) });
    expect(scopeOf(init, 'mfe')).toEqual({ [SORT]: at('mfe', SORT), [X]: at('mfe', X) });
    expect(load.actions[SORT]!.action).toBe('scope');
    expect(scopeOf(load.merged, 'mfe')).toEqual({ [SORT]: at('mfe', SORT), [X]: at('mfe', X) });
  });

  it('merges a family an older flat build ships into its npm name', async () => {
    // A flat copy joins its npm name: an older core bundles its flat mappings together.
    const { init, load, packages } = await pages([
      entry('shell', lib(T, { dense: false })),
      entry('mfe', lib(T, { with: [SORT] }), lib(U)),
    ]);

    expect(packages(T, SORT, U)).toEqual({ [T]: '@s/c', [SORT]: '@s/c', [U]: U });
    expect(init.imports[T]).toBe(at('shell', T));
    expect(scopeOf(init, 'mfe')).toMatchObject({ [T]: at('mfe', T), [SORT]: at('mfe', SORT) });
    expect(scopeOf(load.merged, 'mfe')).toMatchObject({
      [T]: at('mfe', T),
      [SORT]: at('mfe', SORT),
    });
  });

  it('merges a family into an older dense record at npm depth that lists one of it', async () => {
    const { init, load, packages } = await pages([
      entry('shell', lib('@s/c', { with: [T] })),
      entry('mfe', lib(T, { with: [SORT] }), lib(U)),
    ]);

    expect(packages('@s/c', T, SORT, U)).toEqual({
      '@s/c': '@s/c',
      [T]: '@s/c',
      [SORT]: '@s/c',
      [U]: U,
    });
    expect(init.imports).toMatchObject({ '@s/c': at('shell', '@s/c'), [T]: at('shell', T) });
    expect(scopeOf(init, 'mfe')).toMatchObject({ [T]: at('mfe', T), [SORT]: at('mfe', SORT) });
    expect(scopeOf(load.merged, 'mfe')).toMatchObject({
      [T]: at('mfe', T),
      [SORT]: at('mfe', SORT),
    });
  });

  it('runs a build whose records sit at two tags from its own build', async () => {
    // mfe keys `t` and `t/sort` apart at two versions; the shell's one record merges them into one package, which
    // mfe ships at two tags, so at init it falls back to its own build. That is coherent, but the portfolio's
    // tag-based oracle (`findSplitRemotes`) reads a remote reaching one package at two tags as split even when
    // both are its own build's files, so it is off here; `pageTears` judges the page instead.
    const { init, load, packages } = await pages(
      [
        entry('shell', lib(T, { with: [SORT] })),
        entry('mfe', lib(T), lib(SORT, { version: '2.0.0' })),
      ],
      { assertNoTear: false }
    );

    expect(packages(T, SORT)).toEqual({ [T]: T, [SORT]: T });
    expect(scopeOf(init, 'mfe')).toEqual({ [T]: at('mfe', T), [SORT]: at('mfe', SORT) });
    // Loaded over the shell's map, both copies accept its 1.0.0.
    expect(load.actions[T]!.action).toBe('skip');
    expect(load.actions[SORT]!.action).toBe('skip');
    expect(load.merged.scopes ?? {}).toEqual({});
  });

  it('scopes a load whose record merges libraries the map serves from two builds, then merges them', async () => {
    const shell = entry('shell', lib(T));
    const mfe1 = entry('mfe1', lib(SORT));
    const mfe2 = entry('mfe2', lib(T, { with: [SORT] }));
    const { p, load } = await pages([shell, mfe1, mfe2]);

    // The committed map serves `t` from the shell and `t/sort` from mfe1; mfe2's one record cannot follow both.
    expect(load.committed.imports).toEqual({ [T]: at('shell', T), [SORT]: at('mfe1', SORT) });
    expect(load.actions[T]!.action).toBe('scope');
    expect(scopeOf(load.merged, 'mfe2')).toEqual({ [T]: at('mfe2', T), [SORT]: at('mfe2', SORT) });

    // The next page serves the merged package from the shell, which lacks `t/sort`: mfe1 and mfe2 run it themselves.
    p.reload();
    const next = await p.runInit([shell, mfe1, mfe2]);
    expect(next.imports).toEqual({ [T]: at('shell', T) });
    expect(scopeOf(next, 'mfe1')).toEqual({ [SORT]: at('mfe1', SORT) });
    expect(scopeOf(next, 'mfe2')).toEqual({ [T]: at('mfe2', T), [SORT]: at('mfe2', SORT) });
  });

  it('keeps a record that lists only entrypoints under its name with them', async () => {
    // `material/table` publishes `material/table/x` and no root of that name.
    const table = (version?: string) => ({
      ...lib('material/table', { version }),
      entries: { 'material/table/x': file('material/table/x') },
    });
    const { init, load, packages } = await pages([
      entry('shell', table()),
      entry('mfe', table('1.1.0')),
    ]);

    expect(packages('material/table', 'material/table/x')).toEqual({
      'material/table': 'material/table',
      'material/table/x': 'material/table',
    });
    expect(init.imports).toEqual({ 'material/table/x': at('shell', 'material/table/x') });
    expect(load.actions['material/table']!.action).toBe('skip');
  });

  it('runs pooled sibling libraries that import each other from one build', async () => {
    // `u` imports `t`: two packages, coupled only by their shared `pool` label. mfe's strict `t` rejects the
    // shell's, so the pool scopes both for mfe; without the label mfe would scope `t` alone.
    const { init, load } = await pages(
      [
        entry('shell', lib(T, { pool: 'c' }), lib(U, { pool: 'c' })),
        entry(
          'mfe',
          lib(T, { pool: 'c', strict: '1.1.0' }),
          lib(U, { pool: 'c', version: '1.1.0' })
        ),
      ],
      { edges: { [U]: T } }
    );

    expect(scopeOf(init, 'mfe')).toEqual({ [T]: at('mfe', T), [U]: at('mfe', U) });
    expect(scopeOf(load.merged, 'mfe')).toEqual({ [T]: at('mfe', T), [U]: at('mfe', U) });
  });

  it('runs a pooled library under an older flat build of the one it imports from one build', async () => {
    // The flat `t` is the npm package `@s/c`; the declared `t/sort` is a package of its own that imports it.
    const { init, load } = await pages([
      entry('shell', lib(T, { dense: false, pool: 'c' }), lib(SORT, { pool: 'c' })),
      entry(
        'mfe',
        lib(T, { dense: false, pool: 'c', strict: '1.1.0' }),
        lib(SORT, { pool: 'c', version: '1.1.0' })
      ),
    ]);

    expect(scopeOf(init, 'mfe')).toEqual({ [T]: at('mfe', T), [SORT]: at('mfe', SORT) });
    expect(scopeOf(load.merged, 'mfe')).toEqual({ [T]: at('mfe', T), [SORT]: at('mfe', SORT) });
  });
});
