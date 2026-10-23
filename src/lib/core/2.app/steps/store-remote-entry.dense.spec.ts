import type { RemoteEntry, RemoteSharedInfo } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';

/**
 * The providers mark each shared entry the remoteEntry published dense (`dense: true`); both storage paths
 * must keep that mark on the stored copy, since a warm page never refetches the remoteEntry to recover it.
 */
describe('store-remote-entry: the dense mark', () => {
  let storage = 0;

  const shared = (dense: boolean): RemoteSharedInfo => ({
    packageName: '@s/c/table',
    version: '1.0.0',
    requiredVersion: '^1.0.0',
    singleton: true,
    strictVersion: false,
    entries: { '@s/c/table': 'table.js' },
    ...(dense ? { dense: true as const } : {}),
  });

  const entry = (name: string, dense: boolean): RemoteEntry => ({
    name,
    url: `http://${name}/remoteEntry.json`,
    exposes: [],
    shared: [shared(dense)],
  });

  const fresh = () =>
    portfolio({}, { storage: `nf-store-dense-${storage++}`, realRepositories: true });

  // [row action, remote, dense] for every stored copy of the external.
  const copies = (p: ReturnType<typeof fresh>) =>
    p
      .stored()
      ['@s/c/table']!.versions.flatMap(v => v.remotes.map(r => [v.action, r.name, r.dense]));

  it('keeps the mark on the copy an init stores, and only on that copy', async () => {
    const p = fresh();
    await p.runInit([entry('a', true), entry('b', false)]);

    expect(copies(p)).toEqual([
      ['share', 'a', true],
      ['share', 'b', undefined],
    ]);
  });

  it('keeps the mark on the copy a runtime load stores, across a reload', async () => {
    const p = fresh();
    await p.runInit([entry('a', false)]);
    await p.runDynamic(entry('b', true));
    p.reload();

    expect(copies(p)).toEqual([
      ['share', 'a', undefined],
      ['skip', 'b', true],
    ]);
  });
});
