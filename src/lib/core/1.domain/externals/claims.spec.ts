import { claimTable, committedClaims, versionClaims, type Claim } from './claims';
import { GLOBAL_SCOPE, type SharedExternal } from './external.contract';
import type { SharedVersion, SharedVersionAction, SharedVersionMeta } from './version.contract';

const copy = (name: string, entries: string[], extra: Partial<SharedVersionMeta> = {}) =>
  ({
    name,
    requiredVersion: '^1.0.0',
    strictVersion: false,
    cached: false,
    entries: Object.fromEntries(entries.map(e => [e, `${e.replace(/\//g, '-')}.js`])),
    ...extra,
  }) satisfies SharedVersionMeta;

const version = (
  action: SharedVersionAction,
  remotes: SharedVersionMeta[],
  tag = '1.0.0'
): SharedVersion => ({ tag, host: false, action, remotes });

const external = (...versions: SharedVersion[]): SharedExternal => ({ dirty: false, versions });

// Specifier -> "external@tag:remote", the readable form of a claim.
const readable = (claims: Map<string, Claim>) =>
  Object.fromEntries([...claims].map(([s, c]) => [s, `${c.external}@${c.tag}:${c.copy.name}`]));

describe('claimTable', () => {
  it('lets no skip copy claim', () => {
    const table = claimTable([
      ['dep-a', external(version('skip', [copy('r1', ['dep-a', 'dep-b'])]))],
      ['dep-b', external(version('share', [copy('r2', ['dep-b'])], '2.0.0'))],
    ]);

    expect(readable(table.claims)).toEqual({ 'dep-b': 'dep-b@2.0.0:r2' });
  });

  it('keeps the first share row per specifier across externals (flat beside dense)', () => {
    const table = claimTable([
      ['fw', external(version('share', [copy('r1', ['fw', 'fw/testing'])]))],
      ['fw/testing', external(version('share', [copy('r2', ['fw/testing'])], '2.0.0'))],
    ]);

    expect(readable(table.claims)).toEqual({
      fw: 'fw@1.0.0:r1',
      'fw/testing': 'fw@1.0.0:r1',
    });
  });

  it('reports a share row whose external name is already claimed as a duplicate that claims nothing', () => {
    // The `imports[externalName]` guard of the global builder: `fw/testing`'s own row is skipped
    // whole, so its `fw/testing/extra` stays unclaimed by it.
    const late = version('share', [copy('r2', ['fw/testing', 'fw/testing/extra'])], '2.0.0');
    const table = claimTable([
      ['fw', external(version('share', [copy('r1', ['fw', 'fw/testing'])]))],
      ['fw/testing', external(late)],
    ]);

    expect(table.duplicates).toEqual(new Set([late]));
    expect(table.claims.has('fw/testing/extra')).toBe(false);
    // A named scope has no such guard: every share row claims what is still free.
    expect(readable(table.shareClaims)).toEqual({
      fw: 'fw@1.0.0:r1',
      'fw/testing': 'fw@1.0.0:r1',
      'fw/testing/extra': 'fw/testing@2.0.0:r2',
    });
  });

  it('reports a duplicate even when it has nothing left to claim', () => {
    const second = version('share', [copy('r2', [])], '2.0.0');
    const table = claimTable([['dep', external(version('share', [copy('r1', ['dep'])]), second)]]);

    expect(table.duplicates).toEqual(new Set([second]));
  });

  it('never lets a copy served by another build claim', () => {
    const table = claimTable([
      [
        'dep',
        external(
          version('share', [copy('r1', ['dep']), copy('r2', ['dep', 'dep/x'], { servedBy: 'r9' })])
        ),
      ],
    ]);

    expect(readable(table.claims)).toEqual({ dep: 'dep@1.0.0:r1' });
  });

  it('lets the next copy claim what `publishes` turns down', () => {
    const table = claimTable(
      [['dep', external(version('share', [copy('r1', ['dep']), copy('r2', ['dep'])]))]],
      c => c.name !== 'r1'
    );

    expect(readable(table.claims)).toEqual({ dep: 'dep@1.0.0:r2' });
  });

  it('lets a same-tag share row of a claimed name claim nothing, without reporting it as a duplicate', () => {
    // A dense root beside a flat secondary of the same tag is one shared version, not two; the flat row still
    // adds no file of its own build beside the root's.
    const flat = version('share', [copy('r2', ['fw/testing', 'fw/testing/extra'])]);
    const table = claimTable([
      ['fw', external(version('share', [copy('r1', ['fw', 'fw/testing'])]))],
      ['fw/testing', external(flat)],
    ]);

    expect(table.duplicates.size).toBe(0);
    expect(readable(table.claims)).toEqual({
      fw: 'fw@1.0.0:r1',
      'fw/testing': 'fw@1.0.0:r1',
    });
  });

  describe('with a serving build', () => {
    const served = (servingBuild: string, ...versions: SharedVersion[]): SharedExternal => ({
      ...external(...versions),
      servingBuild,
    });

    it('claims the serving copy before any share row earlier in record order', () => {
      const table = claimTable([
        ['fw/testing', served('r2', version('share', [copy('r1', ['fw/testing'])]))],
        [
          'fw',
          served('r2', version('share', [copy('r1', ['fw']), copy('r2', ['fw', 'fw/testing'])])),
        ],
      ]);

      expect(readable(table.claims)).toEqual({
        fw: 'fw@1.0.0:r2',
        'fw/testing': 'fw@1.0.0:r2',
      });
      expect(readable(table.shareClaims)).toEqual(readable(table.claims));
      expect(table.duplicates.size).toBe(0);
    });

    it('lets a same-tag share row claim nothing the serving copy leaves free', () => {
      const table = claimTable([
        ['fw', served('r1', version('share', [copy('r1', ['fw', 'fw/testing'])]))],
        [
          'fw/testing',
          served('r1', version('share', [copy('r2', ['fw/testing', 'fw/testing/extra'])])),
        ],
      ]);

      expect(table.duplicates.size).toBe(0);
      expect(readable(table.claims)).toEqual({
        fw: 'fw@1.0.0:r1',
        'fw/testing': 'fw@1.0.0:r1',
      });
    });

    // In a named scope as in `imports`: one build per package.
    it('claims nothing of a share row the serving copy does not ship', () => {
      const table = claimTable([
        [
          'fw',
          served('r2', version('share', [copy('r1', ['fw', 'fw/extra']), copy('r2', ['fw'])])),
        ],
      ]);

      expect(readable(table.claims)).toEqual({ fw: 'fw@1.0.0:r2' });
      expect(readable(table.shareClaims)).toEqual({ fw: 'fw@1.0.0:r2' });
    });

    it('claims nothing of an external whose serving copy `publishes` turns down', () => {
      const table = claimTable(
        [['fw', served('r2', version('share', [copy('r1', ['fw']), copy('r2', ['fw'])]))]],
        c => c.name !== 'r2'
      );

      expect(readable(table.claims)).toEqual({});
    });

    it('still reports a share row at another tag than the serving copy as a duplicate', () => {
      const other = version('share', [copy('r1', ['fw', 'fw/extra'])], '2.0.0');
      const table = claimTable([
        ['fw', served('r2', other, version('share', [copy('r2', ['fw'])]))],
      ]);

      expect(table.duplicates).toEqual(new Set([other]));
      expect(readable(table.claims)).toEqual({ fw: 'fw@1.0.0:r2' });
    });

    it.fails(
      'publishes both share rows of a serving host that ships the package at two tags',
      () => {
        const host = (entry: string, tag: string) => ({
          ...version('share', [copy('r1', [entry])], tag),
          host: true,
        });
        const table = claimTable([
          ['fw', served('r1', host('fw', '1.0.0'), host('fw/extra', '2.0.0'))],
        ]);

        expect(table.duplicates.size).toBe(0);
        expect(readable(table.claims)).toEqual({ fw: 'fw@1.0.0:r1', 'fw/extra': 'fw@2.0.0:r1' });
      }
    );
  });

  it('ignores scope rows', () => {
    const table = claimTable([['dep', external(version('scope', [copy('r1', ['dep'])]))]]);

    expect(table.claims.size).toBe(0);
    expect(table.shareClaims.size).toBe(0);
  });
});
describe('committedClaims', () => {
  // r1 is the cached copy of the share row, r2 joined it uncached and adds fw/testing, r3 is the load.
  const record = (): [string, SharedExternal][] => [
    [
      'fw',
      external(
        version('share', [
          copy('r3', ['fw', 'fw/testing'], { cached: true }),
          copy('r1', ['fw'], { cached: true }),
          copy('r2', ['fw', 'fw/testing']),
        ])
      ),
    ],
  ];

  it('in the global scope, reads only the cached copies, never the loaded remote', () => {
    const claims = committedClaims(record(), { shareScope: GLOBAL_SCOPE, without: 'r3' });

    expect(readable(claims)).toEqual({ fw: 'fw@1.0.0:r1' });
  });

  it('in a named scope, reads every copy but the loaded remote', () => {
    const claims = committedClaims(record(), { shareScope: 'team', without: 'r3' });

    expect(readable(claims)).toEqual({ fw: 'fw@1.0.0:r1', 'fw/testing': 'fw@1.0.0:r2' });
  });
});

describe('versionClaims', () => {
  const row = () => version('share', [copy('r1', ['fw', 'fw/extra']), copy('r2', ['fw'])]);
  const names = (claims: Map<string, SharedVersionMeta>) =>
    Object.fromEntries([...claims].map(([s, c]) => [s, c.name]));

  it('claims from the serving copy alone', () => {
    expect(names(versionClaims(row(), 'r2'))).toEqual({ fw: 'r2' });
  });

  it('claims every copy in record order without a serving build', () => {
    expect(names(versionClaims(row(), undefined))).toEqual({ fw: 'r1', 'fw/extra': 'r1' });
  });
});
