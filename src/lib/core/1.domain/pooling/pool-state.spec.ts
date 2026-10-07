import type { SharedExternal } from '../externals/external.contract';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { hasPoolResults, scopeHasPoolState, withoutPoolResults } from './pool-state';

const pooledRecord = (): SharedExternal => ({
  dirty: false,
  poolName: 'framework',
  poolWinner: 'team/a',
  versions: [
    {
      tag: '17.0.0',
      host: false,
      action: 'share',
      remotes: [mockVersionRemote('team/a', '@framework/core', { pool: 'framework' })],
    },
    {
      tag: '17.0.0',
      host: false,
      action: 'skip',
      remotes: [
        mockVersionRemote('team/b', '@framework/core', { pool: 'framework', servedBy: 'team/c' }),
      ],
    },
    {
      tag: '16.0.0',
      host: false,
      action: 'scope',
      remotes: [
        {
          ...mockVersionRemote('team/d', '@framework/core', { pool: 'framework' }),
          poolCause: 'incompatible',
        },
      ],
    },
  ],
});

describe('pool results', () => {
  it('counts each thing pooling writes as a result', () => {
    expect(hasPoolResults(pooledRecord())).toBe(true);
    expect(hasPoolResults({ ...pooledRecord(), poolName: undefined })).toBe(true);
    expect(hasPoolResults({ ...withoutPoolResults(pooledRecord()), poolWinner: 'team/a' })).toBe(
      true
    );
    expect(hasPoolResults(withoutPoolResults(pooledRecord()))).toBe(false);

    const onlyCause = withoutPoolResults(pooledRecord());
    onlyCause.versions[2]!.remotes[0]!.poolCause = 'uncovered';
    expect(hasPoolResults(onlyCause)).toBe(true);
  });

  it('does not count the declared pool tag: it is input', () => {
    const tagged = withoutPoolResults(pooledRecord());
    expect(tagged.versions.every(v => v.remotes.every(r => r.pool === 'framework'))).toBe(true);
    expect(hasPoolResults(tagged)).toBe(false);
  });

  it('strips poolName, poolWinner, servedBy and poolCause without touching the record it was given', () => {
    const record = pooledRecord();
    const cleared = withoutPoolResults(record);

    expect(cleared.poolName).toBeUndefined();
    expect('poolWinner' in cleared).toBe(false);
    expect(cleared.versions.flatMap(v => v.remotes).map(r => [r.servedBy, r.poolCause])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    // The dynamic path hands this a committed record, which must stay as the map was built from it.
    expect(record).toEqual(pooledRecord());
  });
});

/**
 * Whether a share scope gives either pooling step anything to do. It reads the stored record, not a flag set
 * while this init's entries were merged: a warm init whose tagged remotes are all cached merges nothing, and
 * pooling still has to coordinate their pool — see docs/version-resolver.md §"How pooling resolves". It takes
 * one scope because a pool never spans share scopes: a tag elsewhere is no reason to pool here.
 */
describe('scopeHasPoolState', () => {
  const external = (pool?: string): SharedExternal => ({
    dirty: false,
    versions: [
      {
        tag: '2.1.1',
        host: false,
        action: 'share',
        remotes: [mockVersionRemote('team/mfe1', 'dep-a', pool ? { pool } : {})],
      },
    ],
  });

  it('reports none for an empty scope', () => {
    expect(scopeHasPoolState({})).toBe(false);
  });

  it('reports none when no stored remote carries a tag', () => {
    expect(scopeHasPoolState({ 'dep-a': external(), 'dep-b': external() })).toBe(false);
  });

  it('reports a declared tag on any external', () => {
    expect(scopeHasPoolState({ 'dep-a': external(), 'dep-b': external('grp') })).toBe(true);
  });

  it('ignores a blank tag', () => {
    expect(scopeHasPoolState({ 'dep-a': external('  ') })).toBe(false);
  });

  // The tags are gone but the record still carries what pooling wrote: the scope must be visited to clear it.
  it('reports any stored pool result with no tag left', () => {
    expect(scopeHasPoolState({ 'dep-a': { ...external(), poolName: 'grp' } })).toBe(true);
    expect(scopeHasPoolState({ 'dep-a': { ...external(), poolWinner: 'team/mfe1' } })).toBe(true);

    const served = external();
    served.versions[0]!.remotes[0]!.servedBy = 'team/mfe2';
    expect(scopeHasPoolState({ 'dep-a': served })).toBe(true);

    const islanded = external();
    islanded.versions[0]!.remotes[0]!.poolCause = 'uncovered';
    expect(scopeHasPoolState({ 'dep-a': islanded })).toBe(true);
  });
});
