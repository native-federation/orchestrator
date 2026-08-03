import type { ForSpreadingPoolDirtiness } from '../../driver-ports/init/for-spreading-pool-dirtiness.port';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import { createSpreadPoolDirtiness } from './spread-pool-dirtiness';
import { mockAdapters } from 'lib/testing/adapters.mock';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { GLOBAL_SCOPE, STRICT_SCOPE, type SharedExternal } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';

/**
 * A pool is one unit of state, so `determine` has to re-elect it as one — otherwise pooling reads its own
 * `scope` verdicts back for the members nobody touched and gate 1 cannot tell them from a range violation
 * the resolver just found. This step is what makes "pooling ran on this pool" imply "every member of it
 * was re-elected". See docs/version-resolver.md §"How pooling resolves".
 */

const ext = (name: string, dirty: boolean, pool?: string): SharedExternal => ({
  dirty,
  versions: [
    {
      tag: '17.0.0',
      host: false,
      action: 'share',
      remotes: [mockVersionRemote('team/mfe1', name, { pool })],
    },
  ],
});

describe('createSpreadPoolDirtiness', () => {
  let spreadPoolDirtiness: ForSpreadingPoolDirtiness;
  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    adapters.sharedExternalsRepo.getScopes = vi.fn(() => [GLOBAL_SCOPE]);
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'global' as const);
    config.feature.useAutoExternalPooling = true;

    spreadPoolDirtiness = createSpreadPoolDirtiness(config, adapters);
  });

  const given = (externals: Record<string, SharedExternal>) => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => externals);
    return externals;
  };

  const dirt = (externals: Record<string, SharedExternal>) =>
    Object.fromEntries(Object.entries(externals).map(([name, e]) => [name, e.dirty]));

  it('marks every member of a pool dirty when one member is', async () => {
    const externals = given({
      '@scope/a': ext('@scope/a', true),
      '@scope/b': ext('@scope/b', false),
      '@scope/c': ext('@scope/c', false),
    });

    await spreadPoolDirtiness();

    expect(dirt(externals)).toEqual({ '@scope/a': true, '@scope/b': true, '@scope/c': true });
  });

  it('leaves a pool alone when no member is dirty — a plain reload must expand nothing', async () => {
    const externals = given({
      '@scope/a': ext('@scope/a', false),
      '@scope/b': ext('@scope/b', false),
    });

    await spreadPoolDirtiness();

    expect(dirt(externals)).toEqual({ '@scope/a': false, '@scope/b': false });
  });

  it('does not even read a clean scope versions — no pool graph on a warm init', async () => {
    // Performance §8, and it was measured: building the graph and then discovering nothing was dirty
    // was the entire pooling cost of a warm init. `buildPools` has to walk every external's versions to
    // find its remotes and tags, so counting reads of `versions` is exactly "was the graph built".
    let reads = 0;
    const watched = (name: string): SharedExternal => {
      const external = ext(name, false);
      const { versions } = external;
      return Object.defineProperty(external, 'versions', {
        get: () => {
          reads++;
          return versions;
        },
      }) as SharedExternal;
    };
    given({ '@scope/a': watched('@scope/a'), '@scope/b': watched('@scope/b') });

    await spreadPoolDirtiness();

    expect(reads).toBe(0);
  });

  it('does not cross pool boundaries', async () => {
    // Two npm scopes are two pools, so the dirty one must not drag the other in.
    const externals = given({
      '@one/a': ext('@one/a', true),
      '@two/b': ext('@two/b', false),
    });

    await spreadPoolDirtiness();

    expect(dirt(externals)).toEqual({ '@one/a': true, '@two/b': false });
  });

  it('never writes — it only mutates the stored records', async () => {
    given({ '@scope/a': ext('@scope/a', true), '@scope/b': ext('@scope/b', false) });

    await spreadPoolDirtiness();

    expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    expect(adapters.sharedExternalsRepo.commit).not.toHaveBeenCalled();
  });

  it('skips the strict scope, as pooling does', async () => {
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'strict' as const);
    adapters.sharedExternalsRepo.getScopes = vi.fn(() => [STRICT_SCOPE]);
    const externals = given({
      '@scope/a': ext('@scope/a', true),
      '@scope/b': ext('@scope/b', false),
    });

    await spreadPoolDirtiness();

    expect(dirt(externals)).toEqual({ '@scope/a': true, '@scope/b': false });
  });

  describe('when auto-pooling is off', () => {
    beforeEach(() => {
      config.feature.useAutoExternalPooling = false;
    });

    it('does nothing when no stored remote carries a pool tag', async () => {
      adapters.sharedExternalsRepo.hasPoolTag = vi.fn(() => false);
      const externals = given({
        'pkg-a': ext('pkg-a', true),
        'pkg-b': ext('pkg-b', false),
      });

      await spreadPoolDirtiness();

      expect(dirt(externals)).toEqual({ 'pkg-a': true, 'pkg-b': false });
      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
    });

    // The tag lives in storage, so a warm init that merged nothing still pools.
    it('spreads across a tag-formed pool when storage carries the tag', async () => {
      adapters.sharedExternalsRepo.hasPoolTag = vi.fn(() => true);
      const externals = given({
        'pkg-a': ext('pkg-a', true, 'grp'),
        'pkg-b': ext('pkg-b', false, 'grp'),
        'pkg-c': ext('pkg-c', false),
      });

      await spreadPoolDirtiness();

      expect(dirt(externals)).toEqual({ 'pkg-a': true, 'pkg-b': true, 'pkg-c': false });
    });
  });
});
