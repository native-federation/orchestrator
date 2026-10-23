import type { shareScope } from './external.contract';
import { packageOfIn, SpecifierTags } from './specifier';
import type { SharedVersionAction, SharedVersionMeta } from './version.contract';

// One stored copy: `dense` when its remoteEntry published the external dense (`'paths'` mappings with
// `denseExternals`, or any dense entry of an older core); flat copies are stored under their specifier.
type Stored = { remote: string; entries: string[]; dense?: boolean; action?: SharedVersionAction };

const meta = ({ remote, entries, dense }: Stored): SharedVersionMeta => ({
  name: remote,
  requiredVersion: '^1.0.0',
  strictVersion: false,
  cached: false,
  ...(dense ? { dense: true as const } : {}),
  entries: Object.fromEntries(entries.map(s => [s, `${remote}/${s}.js`])),
});

const scope = (externals: Record<string, Stored[]>): shareScope =>
  Object.fromEntries(
    Object.entries(externals).map(([name, copies]) => [
      name,
      {
        dirty: false,
        versions: copies.map(copy => ({
          tag: '1.0.0',
          host: false,
          action: copy.action ?? 'share',
          remotes: [meta(copy)],
        })),
      },
    ])
  );

const SPECIFIERS = [
  '@s/c',
  '@s/c/t',
  '@s/c/t/sort',
  '@s/c/u',
  '@s/c/u/y',
  '@s/d',
  '@s/d/v',
  'rxjs',
  'rxjs/operators',
];

const packages = (record: shareScope, loading: Parameters<typeof packageOfIn>[1] = []) => {
  const packageOf = packageOfIn(record, loading);
  return Object.fromEntries(SPECIFIERS.map(s => [s, packageOf(s)]));
};

// What the npm-name rule gives every specifier above: the 4.8.0 grouping.
const BY_NAME = {
  '@s/c': '@s/c',
  '@s/c/t': '@s/c',
  '@s/c/t/sort': '@s/c',
  '@s/c/u': '@s/c',
  '@s/c/u/y': '@s/c',
  '@s/d': '@s/d',
  '@s/d/v': '@s/d',
  rxjs: 'rxjs',
  'rxjs/operators': 'rxjs',
};

// `paths` remotes: each library a dense external of its own, deeper than its npm name.
const paths = (remote: string, ...libs: [string, string[]][]): Record<string, Stored[]> =>
  Object.fromEntries(libs.map(([pkg, entries]) => [pkg, [{ remote, entries, dense: true }]]));

describe('packageOfIn', () => {
  it('is the npm-name rule itself when no copy is dense', () => {
    const record = scope({
      '@s/c/t': [{ remote: 'old', entries: ['@s/c/t'] }],
      'rxjs/operators': [{ remote: 'old', entries: ['rxjs/operators'] }],
    });
    expect(packageOfIn(record)).toBe(packageOfIn({}));
    expect(packages(record)).toEqual(BY_NAME);
  });

  it('is the npm-name rule itself when every dense external is an npm name', () => {
    // An older core's dense externals group exactly what the name rule groups.
    const record = scope({
      '@s/c': [{ remote: 'old', entries: ['@s/c/t', '@s/c/u'], dense: true }],
      rxjs: [{ remote: 'old', entries: ['rxjs', 'rxjs/operators'], dense: true }],
    });
    expect(packageOfIn(record)).toBe(packageOfIn({}));
  });

  it('serves each dense library as its own package when every copy of it agrees', () => {
    const record = scope({
      ...paths('a', ['@s/c/t', ['@s/c/t', '@s/c/t/sort']], ['@s/c/u', ['@s/c/u']]),
      '@s/c/u': [
        { remote: 'a', entries: ['@s/c/u'], dense: true },
        { remote: 'b', entries: ['@s/c/u', '@s/c/u/y'], dense: true },
      ],
    });
    expect(packages(record)).toEqual({
      ...BY_NAME,
      '@s/c/t': '@s/c/t',
      '@s/c/t/sort': '@s/c/t',
      '@s/c/u': '@s/c/u',
      '@s/c/u/y': '@s/c/u',
    });
  });

  it('falls back to the npm name for a library a flat copy also ships', () => {
    // An older core's flat secondary is stored under the same key as the dense library.
    const record = scope({
      '@s/c/t': [
        { remote: 'a', entries: ['@s/c/t', '@s/c/t/sort'], dense: true },
        { remote: 'old', entries: ['@s/c/t'] },
      ],
      ...paths('a', ['@s/c/u', ['@s/c/u']]),
    });
    // The other library under the prefix stays its own: the flat build does not ship it.
    expect(packages(record)).toEqual({ ...BY_NAME, '@s/c/u': '@s/c/u', '@s/c/u/y': '@s/c/u' });
  });

  it('falls back to the npm name for a library a coarser dense external lists among its entries', () => {
    const record = scope({
      ...paths('a', ['@s/c/t', ['@s/c/t']], ['@s/c/u', ['@s/c/u']]),
      '@s/c': [{ remote: 'old', entries: ['@s/c', '@s/c/t'], dense: true }],
    });
    expect(packages(record)).toEqual({ ...BY_NAME, '@s/c/u': '@s/c/u', '@s/c/u/y': '@s/c/u' });
  });

  it('falls back to the npm name for dense libraries nested in each other', () => {
    const record = scope(
      paths('a', ['@s/c/t', ['@s/c/t', '@s/c/t/sort']], ['@s/c/t/sort', ['@s/c/t/sort']])
    );
    expect(packages(record)).toEqual(BY_NAME);
  });

  it('counts copies of every action, not only the shared ones', () => {
    const record = scope({
      '@s/c/t': [
        { remote: 'a', entries: ['@s/c/t'], dense: true },
        { remote: 'old', entries: ['@s/c/t'], action: 'scope' },
      ],
    });
    expect(packages(record)['@s/c/t']).toBe('@s/c');
  });

  it("merges what a load's copies merge, as the record will once they are stored", () => {
    const committed = scope(paths('a', ['@s/c/t', ['@s/c/t']], ['@s/c/u', ['@s/c/u']]));
    const loading = [
      ['@s/c', meta({ remote: 'old', entries: ['@s/c/t', '@s/c/u'], dense: true })],
    ] as const;
    const stored = scope({
      ...paths('a', ['@s/c/t', ['@s/c/t']], ['@s/c/u', ['@s/c/u']]),
      '@s/c': [{ remote: 'old', entries: ['@s/c/t', '@s/c/u'], dense: true }],
    });

    expect(packages(committed)['@s/c/t']).toBe('@s/c/t');
    expect(packages(committed, loading)).toEqual(BY_NAME);
    expect(packages(committed, loading)).toEqual(packages(stored));
  });

  it('never splits a load: a dense load of a fresh library stays its own package', () => {
    const committed = scope({ '@s/c': [{ remote: 'old', entries: ['@s/c/u'], dense: true }] });
    const loading = [['@s/c/t', meta({ remote: 'a', entries: ['@s/c/t'], dense: true })]] as const;
    expect(packages(committed, loading)).toEqual({
      ...BY_NAME,
      '@s/c/t': '@s/c/t',
      '@s/c/t/sort': '@s/c/t',
    });
  });
});

describe('SpecifierTags', () => {
  const twoLibraries = packageOfIn(
    scope(paths('w', ['@s/c/t', ['@s/c/t']], ['@s/c/u', ['@s/c/u']]))
  );

  it("pins an entrypoint nobody lists by its own package's tag", () => {
    // `@s/c/u` is set first: under the npm-name rule it would pin `@s/c/t/sort` at 2.0.0, beside `@s/c/t`@1.0.0.
    const tags = new SpecifierTags(twoLibraries, [
      ['@s/c/u', '2.0.0'],
      ['@s/c/t', '1.0.0'],
    ]);
    expect(tags.pinnedTag('@s/c/t/sort')).toBe('1.0.0');
    // Nor is another library under the prefix pinned by either.
    expect(tags.pinnedTag('@s/c/v')).toBeUndefined();
  });

  it('leaves a library its pins never reach unpinned', () => {
    const tags = new SpecifierTags(twoLibraries, [['@s/c/u', '2.0.0']]);
    expect(tags.pinnedTag('@s/c/t')).toBeUndefined();
  });
});
