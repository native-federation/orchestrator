import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';
import { portfolio } from './portfolio';

/**
 * The harness itself: its oracle must be armed in every mode, or a fixture passes while tearing a remote.
 * With `realRepositories` the remotes' scope URLs come from the remote-info repository, not from the
 * constructor's `scopeUrls` (which such fixtures pass as `{}`); reading the latter checked no remote at all.
 */
describe('portfolio harness', () => {
  const shared = (packageName: string, version: string): DenseSharedInfo =>
    ({
      packageName,
      version,
      requiredVersion: version,
      singleton: true,
      strictVersion: false,
      pool: 'fw',
      entries: { [packageName]: `${packageName.slice(1).replace('/', '_')}.js` },
    }) as DenseSharedInfo;

  const entry = (name: string, ...sharedInfo: DenseSharedInfo[]): RemoteEntry =>
    ({
      name,
      url: `http://${name}/remoteEntry.json`,
      exposes: [],
      shared: sharedInfo,
    }) as unknown as RemoteEntry;

  it('fails runInit on a torn record when the repositories are real', async () => {
    const p = portfolio({}, { storage: 'nf-portfolio-harness', realRepositories: true });
    // Exact ranges: b (2.0.0, newest) wins, a is islanded with its whole family in `scope` rows.
    await p.runInit([
      entry('a', shared('@fw/core', '1.0.0'), shared('@fw/router', '1.0.0')),
      entry('b', shared('@fw/core', '2.0.0'), shared('@fw/router', '2.0.0')),
    ]);
    p.reload();

    // Tear a by hand: its router row turns `skip`, so it runs its own core 1.0.0 next to b's router 2.0.0. The
    // record stays clean, so the warm init elects nothing and only generates the map from it.
    const router = p.record('@fw/router');
    router.versions = router.versions.map(v =>
      v.tag === '1.0.0'
        ? { ...v, action: 'skip' as const, remotes: v.remotes.map(({ poolCause: _, ...r }) => r) }
        : v
    );
    p.adapters.sharedExternalsRepo.addOrUpdate('@fw/router', router, undefined);

    await expect(p.runInit()).rejects.toThrow(/__GLOBAL__\|fw/);
  });
});
