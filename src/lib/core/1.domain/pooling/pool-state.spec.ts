import type { SharedExternal } from '../externals/external.contract';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { hasPoolResults, withoutPoolResults } from './pool-state';

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
