import {
  GLOBAL_SCOPE,
  type SharedExternal,
  type shareScope,
  STRICT_SCOPE,
} from 'lib/core/1.domain';
import type { ForSharedExternalsStorage } from 'lib/core/2.app/driving-ports/for-shared-externals-storage.port';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { poolableScopes, syncPoolNames } from './pool.util';

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

describe('syncPoolNames', () => {
  // An external whose pool dissolved — on the dynamic path, an override reload can drop the copy that carried
  // the tag. Its surviving copies still name the subpool build they ran, which nothing elects any more.
  const dissolved = (): SharedExternal => ({
    dirty: false,
    poolName: 'framework',
    poolWinner: 'team/a',
    versions: [
      {
        tag: '17.0.0',
        host: false,
        action: 'share',
        remotes: [mockVersionRemote('team/a', '@framework/core')],
      },
      {
        tag: '17.0.0',
        host: false,
        action: 'skip',
        remotes: [mockVersionRemote('team/b', '@framework/core', { servedBy: 'team/c' })],
      },
    ],
  });

  it('clears servedBy too off an external in no pool any more, or the map would follow a stale build', () => {
    const addOrUpdate = vi.fn();
    const record = dissolved();

    syncPoolNames({ '@framework/core': record }, new Map(), { addOrUpdate }, '__GLOBAL__');

    const [name, written, scope] = addOrUpdate.mock.calls[0]!;
    expect([name, scope]).toEqual(['@framework/core', '__GLOBAL__']);
    expect(written.poolName).toBeUndefined();
    expect(written.poolWinner).toBeUndefined();
    expect(
      (written as SharedExternal).versions.flatMap(v => v.remotes).map(r => r.servedBy)
    ).toEqual([undefined, undefined]);
    expect(record).toEqual(dissolved());
  });

  it('keeps poolWinner on a rename: the pool was not re-elected', () => {
    const addOrUpdate = vi.fn();
    const record = dissolved();

    syncPoolNames(
      { '@framework/core': record },
      new Map([['angular', [{ name: '@framework/core', external: record }]]]),
      { addOrUpdate },
      '__GLOBAL__'
    );

    const written = addOrUpdate.mock.calls[0]![1] as SharedExternal;
    expect(written.poolName).toBe('angular');
    expect(written.poolWinner).toBe('team/a');
  });
});
