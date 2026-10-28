import type { shareScope } from './external.contract';
import fc from 'fast-check';
import { npmPackageOf, packageOfIn, SpecifierTags } from './specifier';
import type { SharedVersionAction, SharedVersionMeta } from './version.contract';
import { packageOfAsShipped } from 'lib/testing/pooling/page-graph';

// One stored copy: `dense` when its remoteEntry published the external dense (declared mappings with
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

// Declaring remotes: each library a dense external of its own, deeper than its npm name.
const paths = (remote: string, ...libs: [string, string[]][]): Record<string, Stored[]> =>
  Object.fromEntries(libs.map(([pkg, entries]) => [pkg, [{ remote, entries, dense: true }]]));

describe('packageOfIn', () => {
  it('is the npm-name rule itself when no copy is dense', () => {
    const record = scope({
      '@s/c/t': [{ remote: 'old', entries: ['@s/c/t'] }],
      'rxjs/operators': [{ remote: 'old', entries: ['rxjs/operators'] }],
    });
    expect(packageOfIn(record)).toBe(npmPackageOf);
    expect(packages(record)).toEqual(BY_NAME);
  });

  it('is the npm-name rule itself when every dense external is an npm name', () => {
    // An older core's dense externals group exactly what the name rule groups.
    const record = scope({
      '@s/c': [{ remote: 'old', entries: ['@s/c/t', '@s/c/u'], dense: true }],
      rxjs: [{ remote: 'old', entries: ['rxjs', 'rxjs/operators'], dense: true }],
    });
    expect(packageOfIn(record)).toBe(npmPackageOf);
  });

  it('serves each dense record no other record overlaps as its own package', () => {
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

  it('keeps nested records that share nothing apart', () => {
    // Exact tsconfig keys: core publishes `t` and `sort` as two records; only a pool couples them.
    const record = scope(paths('a', ['@s/c/t', ['@s/c/t']], ['@s/c/t/sort', ['@s/c/t/sort']]));
    expect(packages(record)).toMatchObject({ '@s/c/t': '@s/c/t', '@s/c/t/sort': '@s/c/t/sort' });
  });

  it('merges dense records that list the same specifier, named by the shortest name', () => {
    // A `.package('@s/c/t')` build beside one still on exact keys.
    const record = scope({
      '@s/c/t': [
        { remote: 'a', entries: ['@s/c/t', '@s/c/t/sort'], dense: true },
        { remote: 'b', entries: ['@s/c/t'], dense: true },
      ],
      '@s/c/t/sort': [{ remote: 'b', entries: ['@s/c/t/sort'], dense: true }],
    });
    expect(packages(record)).toMatchObject({ '@s/c/t': '@s/c/t', '@s/c/t/sort': '@s/c/t' });
  });

  it("merges a record that lists another record's name", () => {
    // One build with tsconfig keys `@s/c/d/*` and `@s/c/d/t/*`: record `d/t` does not list itself.
    const packageOf = packageOfIn(
      scope(paths('a', ['@s/c/d', ['@s/c/d/t', '@s/c/d/u']], ['@s/c/d/t', ['@s/c/d/t/sort']]))
    );
    expect(['@s/c/d/t', '@s/c/d/u', '@s/c/d/t/sort'].map(packageOf)).toEqual([
      '@s/c/d',
      '@s/c/d',
      '@s/c/d',
    ]);
  });

  it('serves a record that lists only entrypoints as its own package', () => {
    const packageOf = packageOfIn(scope(paths('a', ['m/table', ['m/table/x']])));
    expect([packageOf('m/table'), packageOf('m/table/x')]).toEqual(['m/table', 'm/table']);
  });

  it('merges a dense record with a flat copy of any of its specifiers into the npm name', () => {
    // An older core's flat secondary: its build bundles every mapping, so it is at least the npm package.
    const record = scope({
      '@s/c/t': [
        { remote: 'a', entries: ['@s/c/t', '@s/c/t/sort'], dense: true },
        { remote: 'old', entries: ['@s/c/t'] },
      ],
      ...paths('a', ['@s/c/u', ['@s/c/u']]),
    });
    expect(packages(record)).toEqual({ ...BY_NAME, '@s/c/u': '@s/c/u' });
  });

  it('merges a dense record a coarser dense external overlaps into it', () => {
    const record = scope({
      ...paths('a', ['@s/c/t', ['@s/c/t']], ['@s/c/u', ['@s/c/u']]),
      '@s/c': [{ remote: 'old', entries: ['@s/c', '@s/c/t'], dense: true }],
    });
    expect(packages(record)).toEqual({ ...BY_NAME, '@s/c/u': '@s/c/u' });
  });

  it('gives a specifier no copy lists its npm name', () => {
    const record = scope(paths('a', ['@s/c/t', ['@s/c/t']]));
    expect(packages(record)).toEqual({ ...BY_NAME, '@s/c/t': '@s/c/t' });
  });

  it('puts a specifier no copy lists in the package its npm name joined', () => {
    // Not a shape core emits: a record named `m` that lists `@s/c`, so `@s/c` is in package `m`.
    const record = scope({
      m: [{ remote: 'a', entries: ['m', '@s/c'], dense: true }],
      ...paths('b', ['@s/c/t', ['@s/c/t']]),
    });
    const packageOf = packageOfIn(record);
    expect(packageOf('@s/c/u')).toBe('m');
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
    expect(packages(committed, loading)).toEqual({ ...BY_NAME, '@s/c/t': '@s/c/t' });
  });

  describe('over core-shaped records', () => {
    // Core names a dense record by a prefix of its entries, never coarser than the npm name; a flat copy is
    // stored under its one specifier. Entries-only records (a name the record does not list) are drawn too.
    const PATHS = [
      '@s/c',
      '@s/c/t',
      '@s/c/t/sort',
      '@s/c/t/sort/x',
      '@s/c/u',
      '@s/c/u/y',
      'm',
      'm/n',
      'm/n/o',
    ];
    const under = (s: string, name: string) => s === name || s.startsWith(name + '/');

    type Drawn = { name: string; copy: SharedVersionMeta };
    const drawnCopy: fc.Arbitrary<Drawn> = fc
      .record({
        name: fc.constantFrom(...PATHS),
        dense: fc.boolean(),
        remote: fc.constantFrom('a', 'b', 'c'),
        pick: fc.array(fc.constantFrom(...PATHS), { maxLength: 4 }),
      })
      .map(({ name, dense, remote, pick }) => {
        const listed = dense ? [...new Set(pick.filter(s => under(s, name)))] : [name];
        const entries = listed.length > 0 ? listed : [name];
        return { name, copy: meta({ remote, entries, dense }) };
      });
    const copies = fc.array(drawnCopy, { maxLength: 8 });

    const toScope = (drawn: Drawn[]): shareScope => {
      const record: shareScope = {};
      for (const { name, copy } of drawn)
        (record[name] ??= { dirty: false, versions: [] }).versions.push({
          tag: '1.0.0',
          host: false,
          action: 'share',
          remotes: [copy],
        });
      return record;
    };
    const anchor = ({ name, copy }: Drawn) => (copy.dense ? name : npmPackageOf(name));
    const run = <T extends unknown[]>(property: fc.IProperty<T>) =>
      fc.assert(property, { seed: 1, numRuns: 2000 });

    it('puts every record whole in one package', () => {
      run(
        fc.property(copies, drawn => {
          const packageOf = packageOfIn(toScope(drawn));
          for (const d of drawn) {
            const members = [anchor(d), ...Object.keys(d.copy.entries)];
            expect(new Set(members.map(packageOf)).size).toBe(1);
          }
        })
      );
    });

    it('is never coarser than the npm name, and a package is a path above its specifiers', () => {
      run(
        fc.property(copies, drawn => {
          const packageOf = packageOfIn(toScope(drawn));
          for (const s of PATHS) {
            expect(npmPackageOf(packageOf(s))).toBe(npmPackageOf(s));
            expect(under(s, packageOf(s))).toBe(true);
          }
        })
      );
    });

    it('never splits a committed package on a load', () => {
      run(
        fc.property(copies, copies, (committed, loading) => {
          const before = packageOfIn(toScope(committed));
          const after = packageOfIn(
            toScope(committed),
            loading.map(({ name, copy }) => [name, copy] as const)
          );
          const shipped = [...new Set(committed.flatMap(d => Object.keys(d.copy.entries)))];
          for (const a of shipped)
            for (const b of shipped) if (before(a) === before(b)) expect(after(a)).toBe(after(b));
        })
      );
    });

    it('does not depend on record order', () => {
      run(
        fc.property(copies, drawn => {
          const forward = packageOfIn(toScope(drawn));
          const reversed = packageOfIn(toScope([...drawn].reverse()));
          expect(PATHS.map(reversed)).toEqual(PATHS.map(forward));
        })
      );
    });

    it('serves every specifier a flat copy ships in its npm package', () => {
      run(
        fc.property(copies, drawn => {
          const packageOf = packageOfIn(toScope(drawn));
          for (const { name, copy } of drawn)
            if (!copy.dense) expect(packageOf(name)).toBe(npmPackageOf(name));
        })
      );
    });

    // The 4.8.0 grouping whenever no build declares a library: no page changes until one does.
    it('is the npm-name rule itself when no dense record sits deeper than its npm name', () => {
      run(
        fc.property(copies, drawn => {
          const atNpmDepth = drawn.filter(d => !d.copy.dense || npmPackageOf(d.name) === d.name);
          expect(PATHS.map(packageOfIn(toScope(atNpmDepth)))).toEqual(PATHS.map(npmPackageOf));
        })
      );
    });

    // The page oracle groups by what each build shipped with its own union-find, so it can catch the production
    // rule; on the records core emits the two must agree.
    it("agrees with the page oracle's grouping", () => {
      run(
        fc.property(copies, drawn => {
          const shipped = packageOfAsShipped(
            drawn.map(({ name, copy }) => ({
              packageName: name,
              dense: copy.dense,
              specifiers: Object.keys(copy.entries),
            }))
          );
          expect(PATHS.map(packageOfIn(toScope(drawn)))).toEqual(PATHS.map(shipped));
        })
      );
    });
  });
});

describe('SpecifierTags', () => {
  const twoLibraries = packageOfIn(
    scope(paths('w', ['@s/c/t', ['@s/c/t', '@s/c/t/sort']], ['@s/c/u', ['@s/c/u']]))
  );

  it("pins an entrypoint the tags do not list by its own package's tag", () => {
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
