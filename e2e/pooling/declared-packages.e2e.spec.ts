import { test, expect, type Federation } from '../harness/federation';
import { dep, remote, shape, SCOPE } from '../harness/portfolio';

/**
 * Libraries deeper than their npm name. A workspace whose tsconfig `paths` name libraries like
 * `@shared/components/table` and `@shared/components/collapse` builds each as its own package with core's
 * `build: 'paths'` and publishes it dense under that name. Grouped by npm name, both would be the package
 * `@shared/components`, so a remote whose serving build lacks one library would run all of them from its own
 * build.
 *
 * Records that share a specifier merge into one package, named by the shortest name; see
 * docs/version-resolver.md §"One build per package".
 */
const C = '@shared/components';
const TABLE = `${C}/table`;
const COLLAPSE = `${C}/collapse`;

// One library per package, as a `build: 'paths'` remote publishes it.
const paths = (version: string) => [
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
          remote('team/mfe2', SCOPE.mfe2, paths('1.0.1')),
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
        remote('team/mfe1', SCOPE.mfe1, paths('1.0.0')),
        remote('team/mfe2', SCOPE.mfe2, paths('1.0.0')),
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
});
