import type { RemoteEntry } from 'lib/core/1.domain';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { portfolio } from 'lib/testing/pooling/portfolio';
import { tagSharedInfoByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';

/**
 * A bug inside one pool's election must not fail the whole init, nor leave that pool half-placed. Both
 * pooling steps fall back to the placement that cannot tear. The failure is injected through the version
 * check port: asking it about the `@broken/*` copies' range throws, so judging that pool fails while the
 * `@ok/*` pool runs for real.
 */
describe('pooling contains a failure to the pool it happened in', () => {
  // Only the `@broken/*` copies carry this range.
  const BROKEN = '17.x';

  const rows = (p: ReturnType<typeof portfolio>, name: string) =>
    p
      .record(name)
      .versions.map(v => [
        `${v.tag}:${v.action}`,
        v.remotes.map(r => (r.poolCause ? `${r.name}(${r.poolCause})` : r.name)),
      ]);

  // Throws for the sentinel range whenever `armed()` says so; every other question is real semver.
  const breakRange = (p: ReturnType<typeof portfolio>, armed: () => boolean = () => true) => {
    const isCompatible = p.adapters.versionCheck.isCompatible;
    p.adapters.versionCheck.isCompatible = (version, range) => {
      if (range === BROKEN && armed()) throw new Error('range bug');
      return isCompatible(version, range);
    };
  };

  it('elects the healthy pool and gives the failed one the placement that cannot tear (init)', async () => {
    const p = portfolio(
      { 'team/a': 'http://a/', 'team/b': 'http://b/', 'team/c': 'http://c/' },
      { storage: 'nf-pool-containment' }
    );
    // Armed for the whole init: determine leaves a pool's members to pooling, so only the election, inside
    // the containment, ever asks about the broken range.
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

    // The harness asserts no-tear on the map, so the fallback placement is checked to be tear-free too.
    await p.runInit();

    expect(rows(p, '@ok/core')).toEqual([
      ['17.0.0:share', ['team/a', 'team/b']],
      ['16.0.0:scope', ['team/c(incompatible)']],
    ]);
    // The first arrival keeps the global map; even team/b, which would have shared it, serves itself.
    expect(rows(p, '@broken/core')).toEqual([
      ['17.0.0:share', ['team/a']],
      ['17.0.0:scope', ['team/b(uncovered)']],
      ['16.0.0:scope', ['team/c(uncovered)']],
    ]);
    expect(p.record('@broken/core').poolName).toBe('broken');
    // An emergency placement is no election: it must not break the next healthy election's tie.
    expect(p.record('@broken/core').poolWinner).toBeUndefined();
    expect(p.config.log.error).toHaveBeenCalledWith(
      3,
      expect.any(String),
      expect.objectContaining({ message: 'range bug' })
    );
  });

  it('lets the joiner serve its own family when its pool cannot be judged (dynamic)', async () => {
    const p = portfolio({}, { storage: 'nf-pool-containment-dynamic', realRepositories: true });
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

    // `update-cache` checks the loaded copy's range against the shared tag before the gate runs, outside
    // pooling and by design, so the failure is armed only while the dynamic pooling step judges.
    let judging = false;
    const gate = p.drivers.poolDynamicExternals;
    p.drivers.poolDynamicExternals = cache => {
      judging = true;
      return gate(cache).finally(() => (judging = false));
    };
    breakRange(p, () => judging);

    const { actions } = await p.runDynamic(
      entry('team/b', pkg => (pkg.startsWith('@broken/') ? BROKEN : '^17.0.0'))
    );

    expect(actions['@ok/core']!.action).toBe('skip');
    expect(actions['@broken/core']!.action).toBe('scope');
    expect(actions['@broken/common']!.action).toBe('scope');
    expect(rows(p, '@broken/core')).toEqual([
      ['17.0.0:share', ['team/a']],
      ['17.0.0:scope', ['team/b(uncovered)']],
    ]);
    expect(p.config.log.error).toHaveBeenCalledWith(
      8,
      expect.any(String),
      expect.objectContaining({ message: 'range bug' })
    );
  });
});
