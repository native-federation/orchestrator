import type { SharedExternal } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { writePoolNames } from './pool.util';

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
      [['@framework/core', 'angular']],
      { addOrUpdate },
      '__GLOBAL__'
    );

    expect(addOrUpdate.mock.calls).toEqual([
      ['@framework/core', { ...pooled('framework'), poolName: 'angular' }, '__GLOBAL__'],
    ]);
    expect(record).toEqual(pooled('framework'));
  });
});
