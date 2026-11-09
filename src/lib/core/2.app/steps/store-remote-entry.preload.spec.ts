import type { RemoteEntry, RemoteSharedInfo } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';

/**
 * A warm page never refetches a remoteEntry, so what preloading reads (a module's chunks, a copy's opt-in and its
 * chunks) must survive storage. A copy that did not opt in stores no chunk list: nothing would read it.
 */
describe('store-remote-entry: preload fields', () => {
  let storage = 0;

  const shared = (opts: Partial<RemoteSharedInfo> = {}): RemoteSharedInfo => ({
    packageName: 'lib',
    version: '1.0.0',
    requiredVersion: '^1.0.0',
    singleton: true,
    strictVersion: false,
    entries: { lib: 'lib.js' },
    ...opts,
  });

  const entry = (name: string, lib: Partial<RemoteSharedInfo>): RemoteEntry => ({
    name,
    url: `http://${name}/remoteEntry.json`,
    exposes: [
      { key: './x', outFileName: 'x.js', chunks: ['chunk-X.js'] },
      { key: './y', outFileName: 'y.js' },
    ],
    shared: [shared(lib)],
  });

  const fresh = () =>
    portfolio({}, { storage: `nf-store-preload-${storage++}`, realRepositories: true });

  // [remote, preload, chunks] for every stored copy of `lib`.
  const copies = (p: ReturnType<typeof fresh>) =>
    p.stored()['lib']!.versions.flatMap(v => v.remotes.map(r => [r.name, r.preload, r.chunks]));

  it('keeps the opt-in and its chunks on the copy an init stores, across a reload', async () => {
    const p = fresh();
    await p.runInit([
      entry('a', { preload: true, chunks: ['chunk-L.js'] }),
      entry('b', { version: '1.1.0', chunks: ['chunk-B.js'] }),
    ]);
    p.reload();

    expect(copies(p)).toEqual([
      ['b', undefined, undefined],
      ['a', true, ['chunk-L.js']],
    ]);
  });

  it('keeps the opt-in on the copy a runtime load stores', async () => {
    const p = fresh();
    await p.runInit([entry('a', {})]);
    await p.runDynamic(entry('b', { preload: true }));
    p.reload();

    expect(copies(p)).toEqual([
      ['a', undefined, undefined],
      ['b', true, undefined],
    ]);
  });

  it("keeps a module's chunks and stores none for a module without", async () => {
    const p = fresh();
    await p.runInit([entry('a', {})]);
    p.reload();

    expect(p.adapters.remoteInfoRepo.tryGet('a').get()!.exposes).toEqual([
      { moduleName: './x', file: 'x.js', chunks: ['chunk-X.js'] },
      { moduleName: './y', file: 'y.js' },
    ]);
  });

  it('keeps the opt-in on a scoped copy', async () => {
    const p = fresh();
    await p.runInit([entry('a', { singleton: false, preload: true, chunks: ['chunk-L.js'] })]);
    p.reload();

    expect(p.adapters.scopedExternalsRepo.tryGet('a').get()!['lib']).toMatchObject({
      preload: true,
      chunks: ['chunk-L.js'],
    });
  });
});
