import { test, expect, type Federation } from '../harness/federation';
import { dep, remote, shape, SCOPE } from '../harness/portfolio';

/**
 * Libraries deeper than their npm name. A build that declares `@shared/components/table` and
 * `@shared/components/collapse` as packages with core's `.package()` publishes each dense under that name.
 * Grouped by npm name, both would be the package `@shared/components`, so a remote whose serving build lacks
 * one library would run all of them from its own build. A runtime load is observable only under
 * es-module-shims (`shim: true`), so the runtime case runs there.
 *
 * Records that share a specifier merge into one package, named by the shortest name; see
 * docs/version-resolver.md §"One build per package".
 */
const C = '@shared/components';
const TABLE = `${C}/table`;
const COLLAPSE = `${C}/collapse`;

// One library per package, as a remote that declares them publishes it.
const declared = (version: string) => [
  dep(TABLE, version, { req: '^1.0.0' }),
  dep(COLLAPSE, version, { req: '^1.0.0' }),
];

// The same libraries as an older build publishes them: one package by npm name, with no root entrypoint.
const byName = (version: string, libraries: string[]) => {
  const shared = dep(C, version, { req: '^1.0.0' });
  shared.entries = Object.fromEntries(libraries.map(s => [s, `${s}.js`]));
  return shared;
};

// Distinct files of the entrypoint the page evaluated.
const copiesOf = async (nf: Federation, entrypoint: string) =>
  new Set((await nf.copies()).filter(c => c.entrypoint === entrypoint).map(c => c.url)).size;

const scopedKeys = async (nf: Federation) =>
  Object.values((await nf.map()).scopes ?? {})
    .flatMap(scope => Object.keys(scope))
    .filter(key => key.startsWith(`${C}/`))
    .sort();

test.describe('dense packages deeper than their npm name', () => {
  for (const externals of ['dense', 'flat'] as const) {
    test(`groups by npm name when an older build ships the libraries (${externals})`, async ({
      nf,
    }) => {
      // Split, the host would serve mfe1 its table and collapse would come from another build: mfe1's one
      // bundle would run half from elsewhere.
      await nf.init(
        [
          shape(remote('team/mfe1', SCOPE.mfe1, [byName('1.0.0', [TABLE, COLLAPSE])]), {
            externals,
            chunking: 'dense',
          }),
          remote('team/mfe2', SCOPE.mfe2, declared('1.0.1')),
        ],
        { hostEntry: remote('host', SCOPE.host, [dep(TABLE, '1.0.1', { req: '^1.0.0' })]) }
      );

      // Which build mfe1 follows differs per shape; that it runs both libraries from one does not.
      const { seen } = (await nf.loadAll())['team/mfe1']!;
      expect(new Set([seen[TABLE]!.split('|')[0], seen[COLLAPSE]!.split('|')[0]]).size).toBe(1);
    });
  }

  test('serves a library the host does not import as its own package', async ({ nf }) => {
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, declared('1.0.0')),
        remote('team/mfe2', SCOPE.mfe2, declared('1.0.0')),
      ],
      { hostEntry: remote('host', SCOPE.host, [dep(TABLE, '1.0.0')]) }
    );

    expect(await scopedKeys(nf)).toEqual([]);
    await nf.loadAll();
    expect(await copiesOf(nf, TABLE)).toBe(1);
    expect(await copiesOf(nf, COLLAPSE)).toBe(1);
  });

  // The same page from older builds: the host's build lacks collapse, so each remote runs both libraries from
  // its own build.
  test('runs both libraries per remote when every build groups them by npm name', async ({
    nf,
  }) => {
    await nf.init(
      [
        remote('team/mfe1', SCOPE.mfe1, [byName('1.0.0', [TABLE, COLLAPSE])]),
        remote('team/mfe2', SCOPE.mfe2, [byName('1.0.0', [TABLE, COLLAPSE])]),
      ],
      { hostEntry: remote('host', SCOPE.host, [byName('1.0.0', [TABLE])]) }
    );

    expect(await scopedKeys(nf)).toEqual([COLLAPSE, COLLAPSE, TABLE, TABLE]);
    await nf.loadAll();
    expect(await copiesOf(nf, COLLAPSE)).toBe(2);
  });

  // The host serves table and mfe2 collapse, both declared in one pool. An older flat build loaded at runtime
  // bundles both as `@shared/components`: every tag agrees, but following the map would run its one package
  // from two builds.
  test('runs a pooled older build loaded at runtime from its own build when the map serves its package from two', async ({
    nf,
  }) => {
    const ui = (pkg: string) => dep(pkg, '1.0.0', { req: '^1.0.0', pool: 'ui' });
    const late = shape(remote('team/mfe3', SCOPE.mfe3, [ui('@s/fw'), ui(TABLE), ui(COLLAPSE)]), {
      externals: 'flat',
      chunking: 'dense',
    });
    await nf.init([remote('team/mfe2', SCOPE.mfe2, [ui('@s/fw'), ui(COLLAPSE)])], {
      hostEntry: remote('host', SCOPE.host, [ui('@s/fw'), ui(TABLE)]),
      unlisted: [late],
      shim: true,
    });
    await nf.initRemoteEntry(late.url);

    const { seen } = await nf.load('team/mfe3');
    expect(seen[TABLE]!.split('|')[0]).toBe('mfe3');
    expect(seen[COLLAPSE]!.split('|')[0]).toBe('mfe3');
  });
});
