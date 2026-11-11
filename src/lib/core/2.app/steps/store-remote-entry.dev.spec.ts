import type { RemoteEntry, RemoteSharedInfo } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';

/**
 * A dev build marks its shared externals with `dev: { entryPoint }`. Only the mark is kept, as `dev: true`,
 * whether or not `profile.enableDebugging` is on: the entry point is an absolute path on the build machine that
 * nothing reads.
 */
describe('store-remote-entry: dev mark', () => {
  let storage = 0;

  const entry = (name: string, dev: boolean): RemoteEntry =>
    ({
      name,
      url: `http://${name}/remoteEntry.json`,
      exposes: [],
      shared: [
        {
          packageName: 'lib',
          version: '1.0.0',
          requiredVersion: '^1.0.0',
          singleton: true,
          strictVersion: false,
          entries: { lib: 'lib.js' },
          ...(dev ? { dev: { entryPoint: '/home/dev/projects/lib/src/index.ts' } } : {}),
        } as RemoteSharedInfo,
      ],
    }) as RemoteEntry;

  const fresh = () =>
    portfolio({}, { storage: `nf-store-dev-${storage++}`, realRepositories: true });

  const copies = (p: ReturnType<typeof fresh>) =>
    p.stored()['lib']!.versions.flatMap(v => v.remotes.map(r => [r.name, r.dev]));

  it('stores dev: true only on the copy that carries the mark, and never the entry point', async () => {
    const p = fresh();
    await p.runInit([entry('a', true), entry('b', false)]);
    p.reload();

    expect(copies(p)).toEqual([
      ['a', true],
      ['b', undefined],
    ]);
    expect(JSON.stringify(p.stored())).not.toContain('entryPoint');
  });

  it('stores the mark on the copy a runtime load stores', async () => {
    const p = fresh();
    await p.runInit([entry('a', false)]);
    await p.runDynamic(entry('b', true));
    p.reload();

    expect(copies(p)).toEqual([
      ['a', undefined],
      ['b', true],
    ]);
    expect(JSON.stringify(p.stored())).not.toContain('entryPoint');
  });
});
