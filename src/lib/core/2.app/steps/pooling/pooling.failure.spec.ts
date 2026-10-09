import type { RemoteEntry } from 'lib/core/1.domain';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { portfolio } from 'lib/testing/pooling/portfolio';
import { tagSharedInfoByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';

/**
 * An unexpected error inside pooling fails the init or the runtime load, as one in determine does (D-4); no
 * fallback placement. The failure is injected through the version check port: asking it about the
 * `@broken/*` copies' range throws, so judging that pool fails while the `@ok/*` pool runs for real.
 */
describe('a pooling error', () => {
  // Only the `@broken/*` copies carry this range.
  const BROKEN = '17.x';

  // Throws for the sentinel range whenever `armed()` says so; every other question is real semver.
  const breakRange = (p: ReturnType<typeof portfolio>, armed: () => boolean = () => true) => {
    const isCompatible = p.adapters.versionCheck.isCompatible;
    p.adapters.versionCheck.isCompatible = (version, range) => {
      if (range === BROKEN && armed()) throw new Error('range bug');
      return isCompatible(version, range);
    };
  };

  // Fails until rework 20 D-4 drops the init step's containment, which places the pool instead.
  it.fails('fails the init, naming the share scope', async () => {
    const p = portfolio(
      { 'team/a': 'http://a/', 'team/b': 'http://b/', 'team/c': 'http://c/' },
      { storage: 'nf-pool-failure-init' }
    );
    // Armed for the whole init: determine leaves a pool's members to pooling, so only the election asks
    // about the broken range.
    breakRange(p);
    for (const family of ['@ok', '@broken'])
      for (const name of [`${family}/core`, `${family}/common`]) {
        const req = (major: string) => (family === '@broken' ? BROKEN : `^${major}.0.0`);
        p.seed(name, [
          p.version('17.0.0', name, [
            { remote: 'team/a', req: req('17') },
            { remote: 'team/b', req: req('17') },
          ]),
          p.version('16.0.0', name, [{ remote: 'team/c', req: req('16') }]),
        ]);
      }

    await expect(p.runInit()).rejects.toThrow(
      'Could not pool shared externals in scope __GLOBAL__.'
    );
    expect(p.config.log.error).toHaveBeenCalledWith(
      3,
      expect.any(String),
      expect.objectContaining({ error: expect.objectContaining({ message: 'range bug' }) })
    );
  });

  it('fails the runtime load', async () => {
    const p = portfolio({}, { storage: 'nf-pool-failure-dynamic', realRepositories: true });
    const NAMES = ['@ok/core', '@ok/common', '@broken/core', '@broken/common'];
    const entry = (name: string, range: (pkg: string) => string): RemoteEntry => ({
      name,
      url: `http://${name.split('/')[1]}/remoteEntry.json`,
      exposes: [],
      shared: tagSharedInfoByNpmScope(
        NAMES.map(pkg =>
          mockSharedInfo(pkg, { requiredVersion: range(pkg), version: '17.0.0', singleton: true })
        )
      ),
    });
    await p.runInit([entry('team/a', () => '^17.0.0')]);

    // `update-cache` checks the loaded copy's range against the shared tag before pooling runs, outside
    // pooling and by design, so the failure is armed only while the dynamic pooling step judges.
    let judging = false;
    const gate = p.drivers.poolDynamicExternals;
    p.drivers.poolDynamicExternals = cache => {
      judging = true;
      return gate(cache).finally(() => (judging = false));
    };
    breakRange(p, () => judging);

    await expect(
      p.runDynamic(entry('team/b', pkg => (pkg.startsWith('@broken/') ? BROKEN : '^17.0.0')))
    ).rejects.toThrow('range bug');
  });
});
