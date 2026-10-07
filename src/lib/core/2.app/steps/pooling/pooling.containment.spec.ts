import type { RemoteEntry, SharedVersion } from 'lib/core/1.domain';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { portfolio } from 'lib/testing/pooling/portfolio';
import { tagSharedInfoByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';
import { createPoolDynamicExternals } from './pool-dynamic-externals';

/**
 * A bug inside one pool's election must not fail the whole init, nor leave that pool half-placed. Both
 * pooling steps fall back to the placement that cannot tear. The failures are injected: the `@broken/*`
 * pool's election (init) and committed view (dynamic) throw, the `@ok/*` pool runs for real.
 */
vi.mock('./election', async importOriginal => {
  const actual = await importOriginal<typeof import('./election')>();
  return {
    ...actual,
    electVariants: (input: Parameters<typeof actual.electVariants>[0]) => {
      if (input.members[0]!.name.startsWith('@broken/')) throw new Error('election bug');
      return actual.electVariants(input);
    },
  };
});

vi.mock('./pool-views', async importOriginal => {
  const actual = await importOriginal<typeof import('./pool-views')>();
  return {
    ...actual,
    committedView: (members: Parameters<typeof actual.committedView>[0]) => {
      if (members[0]!.name.startsWith('@broken/')) throw new Error('gate bug');
      return actual.committedView(members);
    },
  };
});

describe('pooling contains a failure to the pool it happened in', () => {
  const SCOPE = {
    'team/a': 'http://a/',
    'team/b': 'http://b/',
    'team/c': 'http://c/',
  };

  let p: ReturnType<typeof portfolio>;
  beforeEach(() => {
    p = portfolio(SCOPE, { storage: 'nf-pool-containment' });
  });

  const version = (
    tag: string,
    external: string,
    remotes: string[],
    action: SharedVersion['action'] = 'skip'
  ): SharedVersion =>
    p.version(
      tag,
      external,
      remotes.map(remote => ({
        remote,
        req: `^${tag.split('.')[0]}.0.0`,
        cached: action === 'share',
      })),
      action
    );

  const rows = (name: string) =>
    p
      .record(name)
      .versions.map(v => [
        `${v.tag}:${v.action}`,
        v.remotes.map(r => (r.poolCause ? `${r.name}(${r.poolCause})` : r.name)),
      ]);

  it('elects the healthy pool and gives the failed one the placement that cannot tear (init)', async () => {
    for (const family of ['@ok', '@broken'])
      for (const name of [`${family}/core`, `${family}/common`])
        p.seed(name, [
          version('17.0.0', name, ['team/a', 'team/b']),
          version('16.0.0', name, ['team/c']),
        ]);

    // The harness asserts no-tear on the map, so the fallback placement is checked to be tear-free too.
    await p.runInit();

    expect(rows('@ok/core')).toEqual([
      ['17.0.0:share', ['team/a', 'team/b']],
      ['16.0.0:scope', ['team/c(incompatible)']],
    ]);
    // The first arrival keeps the global map; even team/b, which would have shared it, serves itself.
    expect(rows('@broken/core')).toEqual([
      ['17.0.0:share', ['team/a']],
      ['17.0.0:scope', ['team/b(uncovered)']],
      ['16.0.0:scope', ['team/c(uncovered)']],
    ]);
    expect(p.record('@broken/core').poolName).toBe('broken');
    // An emergency placement is no election: it must not break the next healthy election's tie.
    expect(p.record('@broken/core').poolWinner).toBeUndefined();
    expect(p.config.log.error).toHaveBeenCalledWith(
      3,
      "[__GLOBAL__][pool:broken] could not elect the pool; only 'team/a' resolves globally, every other remote serves its own family.",
      expect.objectContaining({ message: 'election bug' })
    );
  });

  it('lets the joiner serve its own family when its pool cannot be judged (dynamic)', async () => {
    for (const family of ['@ok', '@broken'])
      for (const name of [`${family}/core`, `${family}/common`])
        p.seed(name, [version('17.0.0', name, ['team/a', 'team/b'], 'share')], false);

    const entry = {
      name: 'team/b',
      url: 'http://b/remoteEntry.json',
      exposes: [],
      shared: tagSharedInfoByNpmScope(
        ['@ok/core', '@ok/common', '@broken/core', '@broken/common'].map(name =>
          mockSharedInfo(name, { requiredVersion: '^17.0.0', version: '17.0.0', singleton: true })
        )
      ),
    } as RemoteEntry;

    const { actions } = await createPoolDynamicExternals(
      p.config,
      p.adapters
    )({
      entry,
      actions: Object.fromEntries(
        ['@ok/core', '@ok/common', '@broken/core', '@broken/common'].map(n => [
          n,
          { action: 'skip' as const, covered: [n] },
        ])
      ),
    });

    expect(actions['@ok/core']).toEqual({ action: 'skip', covered: ['@ok/core'] });
    expect(actions['@broken/core']).toEqual({ action: 'scope' });
    expect(actions['@broken/common']).toEqual({ action: 'scope' });
    expect(rows('@broken/core')).toEqual([
      ['17.0.0:share', ['team/a']],
      ['17.0.0:scope', ['team/b(uncovered)']],
    ]);
    expect(p.config.log.error).toHaveBeenCalledWith(
      8,
      '[__GLOBAL__][team/b] could not judge its pool; it serves its own family.',
      expect.objectContaining({ message: 'gate bug' })
    );
  });
});
