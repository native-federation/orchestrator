import type { SharedExternal, shareScope } from '../externals/external.contract';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import {
  hasPoolResults,
  renamedRecords,
  scopeHasPoolState,
  withoutPoolResults,
} from './pool-state';

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

  it('does not count the declared pool label: it is input', () => {
    const labelled = withoutPoolResults(pooledRecord());
    expect(labelled.versions.every(v => v.remotes.every(r => r.pool === 'framework'))).toBe(true);
    expect(hasPoolResults(labelled)).toBe(false);
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
 * while this init's entries were merged: a warm init whose labelled remotes are all cached merges nothing, and
 * pooling still has to coordinate their pool — see docs/version-resolver.md §"How pooling resolves". It takes
 * one scope because a pool never spans share scopes: a label elsewhere is no reason to pool here.
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

  it('reports none when no stored remote carries a label', () => {
    expect(scopeHasPoolState({ 'dep-a': external(), 'dep-b': external() })).toBe(false);
  });

  it('reports a declared label on any external', () => {
    expect(scopeHasPoolState({ 'dep-a': external(), 'dep-b': external('grp') })).toBe(true);
  });

  it('ignores a blank label', () => {
    expect(scopeHasPoolState({ 'dep-a': external('  ') })).toBe(false);
  });

  // The labels are gone but the record still carries what pooling wrote: the scope must be visited to clear it.
  it('reports any stored pool result with no label left', () => {
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

describe('renamedRecords', () => {
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
  const pool = (scope: shareScope, ...names: string[]) =>
    names.map(name => ({ name, external: scope[name]! }));

  // A dynamic load writes the pools it judged; one it merged renames committed members it never rewrote.
  it('names a member that stored no pool yet, and skips one already named right', () => {
    const scope: shareScope = { core: pooled('framework'), common: pooled() };

    expect(renamedRecords(scope, new Map([['framework', pool(scope, 'core', 'common')]]))).toEqual([
      ['common', { ...pooled(), poolName: 'framework' }],
    ]);
  });

  it('renames a member stored under another name, and nothing in no pool', () => {
    const scope: shareScope = { '@framework/core': pooled('old'), stale: pooled('gone') };

    expect(renamedRecords(scope, new Map([['angular', pool(scope, '@framework/core')]]))).toEqual([
      ['@framework/core', { ...pooled('old'), poolName: 'angular' }],
    ]);
  });

  it('reads the stored name from the scope, not from the member it was handed', () => {
    // The dynamic path passes the committed records merged with what it just wrote.
    const before = pooled('old');
    const scope: shareScope = { a: pooled('p') };

    expect(renamedRecords(scope, new Map([['p', [{ name: 'a', external: before }]]]))).toEqual([]);
  });

  it('keeps poolWinner and servedBy on a rename: the pool was not re-elected', () => {
    const record = pooled('framework');
    const scope: shareScope = { '@framework/core': record };

    expect(renamedRecords(scope, new Map([['angular', pool(scope, '@framework/core')]]))).toEqual([
      ['@framework/core', { ...pooled('framework'), poolName: 'angular' }],
    ]);
    expect(record).toEqual(pooled('framework'));
  });
});
