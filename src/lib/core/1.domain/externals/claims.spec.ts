import { claimTable, type Claim } from './claims';
import type { SharedExternal } from './external.contract';
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
  Object.fromEntries(
    [...claims].map(([s, c]) => [s, `${c.external}@${c.tag}:${c.copy.name}:${c.action}`])
  );

describe('claimTable', () => {
  it('claims every share row in record order before any skip copy', () => {
    const table = claimTable([
      ['dep-a', external(version('skip', [copy('r1', ['dep-a', 'dep-b'])]))],
      ['dep-b', external(version('share', [copy('r2', ['dep-b'])], '2.0.0'))],
    ]);

    expect(readable(table.claims)).toEqual({
      'dep-b': 'dep-b@2.0.0:r2:share',
      'dep-a': 'dep-a@1.0.0:r1:skip',
    });
    // Insertion order is claim order: the share row's claim comes first.
    expect([...table.claims.keys()]).toEqual(['dep-b', 'dep-a']);
  });

  it('keeps the first share row per specifier across externals (flat beside dense)', () => {
    const table = claimTable([
      ['fw', external(version('share', [copy('r1', ['fw', 'fw/testing'])]))],
      ['fw/testing', external(version('share', [copy('r2', ['fw/testing'])], '2.0.0'))],
    ]);

    expect(readable(table.claims)).toEqual({
      fw: 'fw@1.0.0:r1:share',
      'fw/testing': 'fw@1.0.0:r1:share',
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
      fw: 'fw@1.0.0:r1:share',
      'fw/testing': 'fw@1.0.0:r1:share',
      'fw/testing/extra': 'fw/testing@2.0.0:r2:share',
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
      ['other', external(version('skip', [copy('r3', ['dep/x'], { servedBy: 'r9' })]))],
    ]);

    expect(readable(table.claims)).toEqual({ dep: 'dep@1.0.0:r1:share' });
  });

  it('lets the next copy claim what `publishes` turns down', () => {
    const table = claimTable(
      [['dep', external(version('share', [copy('r1', ['dep']), copy('r2', ['dep'])]))]],
      c => c.name !== 'r1'
    );

    expect(readable(table.claims)).toEqual({ dep: 'dep@1.0.0:r2:share' });
  });

  it('ignores scope rows', () => {
    const table = claimTable([['dep', external(version('scope', [copy('r1', ['dep'])]))]]);

    expect(table.claims.size).toBe(0);
    expect(table.shareClaims.size).toBe(0);
  });
});
