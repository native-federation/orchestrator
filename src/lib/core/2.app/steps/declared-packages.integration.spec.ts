import type { ImportMap, RemoteEntry, RemoteSharedInfo, shareScope } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';

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

const fresh = (hosts: string[] = []) =>
  portfolio({}, { storage: `nf-declared-packages-${storage++}`, realRepositories: true, hosts });

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
