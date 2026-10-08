import {
  GLOBAL_SCOPE,
  type SharedExternal,
  type shareScope,
  STRICT_SCOPE,
} from 'lib/core/1.domain';
import type { ForSharedExternalsStorage } from 'lib/core/2.app/driving-ports/for-shared-externals-storage.port';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { poolableScopes, writePoolNames } from './pool.util';

// W1's real guard: a pool never spans share scopes, so a tag in one scope must not put the others through a
// pool graph. The flow-level "skips work" test in pool-shared-externals.spec.ts only shows the cost.
describe('poolableScopes', () => {
  const external = (pool?: string): SharedExternal => ({
    dirty: false,
    versions: [
      {
        tag: '1.0.0',
        host: false,
        action: 'share',
        remotes: [mockVersionRemote('team/a', 'dep', pool ? { pool } : {})],
      },
    ],
  });

  const repo = (
    scopes: Record<string, shareScope>
  ): Pick<ForSharedExternalsStorage, 'getScopes' | 'scopeType' | 'getFromScope'> => ({
    getScopes: () => Object.keys(scopes),
    scopeType: scope =>
      scope === GLOBAL_SCOPE ? 'global' : scope === STRICT_SCOPE ? 'strict' : 'shareScope',
    getFromScope: scope => ({ ...scopes[scope ?? GLOBAL_SCOPE] }),
  });

  const storage = repo({
    [GLOBAL_SCOPE]: { 'dep-a': external('grp'), 'dep-b': external() },
    'team-b': { 'dep-c': external(), 'dep-d': external() },
    [STRICT_SCOPE]: { 'dep-e': external('grp') },
  });

  it('keeps only a non-strict scope holding pool state, with what it holds', () => {
    expect(poolableScopes(storage)).toEqual([
      [GLOBAL_SCOPE, { 'dep-a': external('grp'), 'dep-b': external() }],
    ]);
  });

  it('keeps an untagged scope that still holds a pool result', () => {
    const scopes = repo({ 'team-b': { 'dep-c': { ...external(), poolName: 'grp' } } });
    expect(poolableScopes(scopes).map(([scope]) => scope)).toEqual(['team-b']);
  });

  it('never reads a scope the caller filters out', () => {
    const read = vi.fn(storage.getFromScope);
    expect(poolableScopes({ ...storage, getFromScope: read }, scope => scope === 'team-b')).toEqual(
      []
    );
    expect(read.mock.calls).toEqual([['team-b']]);
  });
});

describe('writePoolNames', () => {
  const pooled = (poolName?: string): SharedExternal => ({
    dirty: false,
    ...(poolName === undefined ? {} : { poolName }),
    poolWinner: 'team/a',
    versions: [
      {
        tag: '17.0.0',
        host: false,
        action: 'skip',
        remotes: [mockVersionRemote('team/b', '@framework/core', { servedBy: 'team/c' })],
      },
    ],
  });

  it('keeps poolWinner and servedBy on a rename: the pool was not re-elected', () => {
    const addOrUpdate = vi.fn();
    const record = pooled('framework');

    writePoolNames(
      { '@framework/core': record },
      new Map([['angular', [{ name: '@framework/core', external: record }]]]),
      { addOrUpdate },
      '__GLOBAL__'
    );

    expect(addOrUpdate.mock.calls).toEqual([
      ['@framework/core', { ...pooled('framework'), poolName: 'angular' }, '__GLOBAL__'],
    ]);
    expect(record).toEqual(pooled('framework'));
  });

  // A dynamic load writes the pools it judged; one it merged renames committed members it never rewrote.
  it('names a member that stored no pool yet, and skips one already named right', () => {
    const addOrUpdate = vi.fn();
    const named = pooled('framework');
    const fresh = pooled();

    writePoolNames(
      { core: named, common: fresh },
      new Map([
        [
          'framework',
          [
            { name: 'core', external: named },
            { name: 'common', external: fresh },
          ],
        ],
      ]),
      { addOrUpdate },
      '__GLOBAL__'
    );

    expect(addOrUpdate.mock.calls.map(([name, written]) => [name, written.poolName])).toEqual([
      ['common', 'framework'],
    ]);
  });

  it('writes nothing for a pool the caller rebuilds, nor for an external in no pool', () => {
    const addOrUpdate = vi.fn();
    const record = pooled('old');

    writePoolNames(
      { '@framework/core': record, stale: pooled('gone') },
      new Map([['angular', [{ name: '@framework/core', external: record }]]]),
      { addOrUpdate },
      '__GLOBAL__',
      new Set(['angular'])
    );

    expect(addOrUpdate).not.toHaveBeenCalled();
  });
});
