import type { SharedExternal } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { syncPoolNames } from './pool.util';

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
