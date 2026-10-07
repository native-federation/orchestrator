import type { ForMarkingPoolsForReelection } from '../../driver-ports/init/for-marking-pools-for-reelection.port';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import { createMarkPoolsForReelection } from './mark-pools-for-reelection';
import { mockAdapters } from 'lib/testing/adapters.mock';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { GLOBAL_SCOPE, STRICT_SCOPE, type SharedExternal } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { npmScope } from 'lib/testing/pooling/tag-by-npm-scope';

/**
 * A pool is one unit of state, so `determine` has to re-elect it as one — otherwise pooling reads its own
 * `scope` verdicts back for the members nobody touched and the election cannot tell them from a range
 * violation the resolver just found. This step is what makes "pooling ran on this pool" imply "every member
 * of it was re-elected". See docs/version-resolver.md §"How pooling resolves".
 */

// Tagged by npm scope unless told otherwise, as the build tags them by default. Pass `null` for no tag.
const ext = (
  name: string,
  dirty: boolean,
  pool: string | null = npmScope(name) ?? null
): SharedExternal => ({
  dirty,
  versions: [
    {
      tag: '17.0.0',
      host: false,
      action: 'share',
      remotes: [mockVersionRemote('team/mfe1', name, { pool: pool ?? undefined })],
    },
  ],
});

describe('createMarkPoolsForReelection', () => {
  let markPoolsForReelection: ForMarkingPoolsForReelection;
  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    adapters.sharedExternalsRepo.getScopes = vi.fn(() => [GLOBAL_SCOPE]);
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'global' as const);

    markPoolsForReelection = createMarkPoolsForReelection(config, adapters);
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

    await markPoolsForReelection();

    expect(dirt(externals)).toEqual({ '@scope/a': true, '@scope/b': true, '@scope/c': true });
  });

  it('returns the members of every pool up for re-election, per scope, for determine to leave alone', async () => {
    // @scope is up (a is dirty); @other is clean, and the untagged external is in no pool at all.
    given({
      '@scope/a': ext('@scope/a', true),
      '@scope/b': ext('@scope/b', false),
      '@other/x': ext('@other/x', false),
      '@other/y': ext('@other/y', false),
      plain: ext('plain', true, null),
    });

    const pooled = await markPoolsForReelection();

    expect(pooled).toEqual(new Map([[GLOBAL_SCOPE, new Set(['@scope/a', '@scope/b'])]]));
  });

  it('leaves a pool alone when no member is dirty — a plain reload must expand nothing', async () => {
    const externals = given({
      '@scope/a': ext('@scope/a', false),
      '@scope/b': ext('@scope/b', false),
    });

    await markPoolsForReelection();

    expect(dirt(externals)).toEqual({ '@scope/a': false, '@scope/b': false });
  });

  it('does not cross pool boundaries', async () => {
    // Two npm scopes are two pools, so the dirty one must not drag the other in.
    const externals = given({
      '@one/a': ext('@one/a', true),
      '@two/b': ext('@two/b', false),
    });

    await markPoolsForReelection();

    expect(dirt(externals)).toEqual({ '@one/a': true, '@two/b': false });
  });

  it('skips the strict scope, as pooling does', async () => {
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'strict' as const);
    adapters.sharedExternalsRepo.getScopes = vi.fn(() => [STRICT_SCOPE]);
    const externals = given({
      '@scope/a': ext('@scope/a', true),
      '@scope/b': ext('@scope/b', false),
    });

    await markPoolsForReelection();

    expect(dirt(externals)).toEqual({ '@scope/a': true, '@scope/b': false });
  });

  // Pool state outside a pool is stale by definition — only pooling writes it — and pooling never visits an
  // external it does not pool, so this step, which runs before `determine`, is the one that can drop it.
  // Regression for a leftover `servedBy` pointing a copy at a build after its pool had dissolved
  // (e2e/pooling/lifecycle.e2e.spec.ts, "drops a stale subpool").
  describe('clears pool state off an external that left every pool', () => {
    const withState = (external: SharedExternal): SharedExternal => {
      external.poolName = 'framework';
      external.poolWinner = 'team/mfe1';
      external.versions[0]!.remotes[0]!.servedBy = 'team/mfe2';
      external.versions[0]!.remotes[0]!.poolCause = 'uncovered';
      return external;
    };

    it('drops servedBy, poolCause, poolName and poolWinner, and marks the external for re-election', async () => {
      const externals = given({
        '@scope/a': ext('@scope/a', true, null),
        '@scope/b': withState(ext('@scope/b', false, null)),
      });

      await markPoolsForReelection();

      const b = externals['@scope/b']!;
      expect(b.poolName).toBeUndefined();
      expect(b.poolWinner).toBeUndefined();
      expect(b.versions[0]!.remotes[0]!.servedBy).toBeUndefined();
      expect(b.versions[0]!.remotes[0]!.poolCause).toBeUndefined();
      // Re-elected, since `determine` treated the subpool copy as exempt from the coverage policy.
      expect(b.dirty).toBe(true);
    });

    it('keeps the state of an external that is still pooled', async () => {
      const externals = given({
        '@scope/a': ext('@scope/a', true),
        '@scope/b': withState(ext('@scope/b', false)),
      });

      await markPoolsForReelection();

      expect(externals['@scope/b']!.versions[0]!.remotes[0]!.servedBy).toBe('team/mfe2');
      expect(externals['@scope/b']!.poolName).toBe('framework');
      expect(externals['@scope/b']!.poolWinner).toBe('team/mfe1');
    });

    it('leaves a clean unpooled external alone', async () => {
      const externals = given({
        '@scope/a': ext('@scope/a', true, null),
        rxjs: ext('rxjs', false, null),
      });

      await markPoolsForReelection();

      expect(externals['rxjs']!.dirty).toBe(false);
    });

    it('does nothing on a warm init, however stale the record', async () => {
      const externals = given({ '@scope/b': withState(ext('@scope/b', false, null)) });

      await markPoolsForReelection();

      expect(externals['@scope/b']!.versions[0]!.remotes[0]!.servedBy).toBe('team/mfe2');
      expect(externals['@scope/b']!.dirty).toBe(false);
    });
  });

  // Performance contracts: W1, a scope carrying no pool state is never read; W2, a warm init (nothing
  // dirty) builds no pool graph. The last test is the control proving the skip is selective.
  describe('skips work', () => {
    it('builds no pool graph when nothing is dirty (W2)', async () => {
      // Measured: building the graph and then discovering nothing was dirty was the entire pooling cost of
      // a warm init. `buildPools` has to walk every external's versions to find its remotes and tags, so
      // counting reads of `versions` is exactly "was the graph built".
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

      await markPoolsForReelection();

      expect(reads).toBe(0);
    });

    // Grouped for what it pins today, no storage I/O; Phase 3 of plan.md changes this behaviour.
    it('never writes — it only mutates the stored records', async () => {
      given({ '@scope/a': ext('@scope/a', true), '@scope/b': ext('@scope/b', false) });

      await markPoolsForReelection();

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.commit).not.toHaveBeenCalled();
    });

    it('reads no scope when no stored remote carries a pool tag (W1)', async () => {
      adapters.sharedExternalsRepo.hasPoolState = vi.fn(() => false);
      const externals = given({
        'pkg-a': ext('pkg-a', true),
        'pkg-b': ext('pkg-b', false),
      });

      await markPoolsForReelection();

      expect(dirt(externals)).toEqual({ 'pkg-a': true, 'pkg-b': false });
      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
    });

    // The narrowing: a tag in one scope cannot form a pool in another, so the untagged scopes are never
    // read. Before this, one tag anywhere put every non-strict scope through a pool-graph build.
    it('reads only the scopes that carry a pool tag (W1)', async () => {
      adapters.sharedExternalsRepo.getScopes = vi.fn(() => [GLOBAL_SCOPE, 'team-a', 'team-b']);
      adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'shareScope' as const);
      adapters.sharedExternalsRepo.hasPoolState = vi.fn(scope => scope === 'team-a');
      given({ 'pkg-a': ext('pkg-a', true, 'grp'), 'pkg-b': ext('pkg-b', false, 'grp') });

      await markPoolsForReelection();

      expect(adapters.sharedExternalsRepo.getFromScope).toHaveBeenCalledTimes(1);
      expect(adapters.sharedExternalsRepo.getFromScope).toHaveBeenCalledWith('team-a');
    });

    // The tag lives in storage, so a warm init that merged nothing still pools.
    it('still spreads across a tag-formed pool when storage carries the tag', async () => {
      adapters.sharedExternalsRepo.hasPoolState = vi.fn(() => true);
      const externals = given({
        'pkg-a': ext('pkg-a', true, 'grp'),
        'pkg-b': ext('pkg-b', false, 'grp'),
        'pkg-c': ext('pkg-c', false, null),
      });

      await markPoolsForReelection();

      expect(dirt(externals)).toEqual({ 'pkg-a': true, 'pkg-b': true, 'pkg-c': false });
    });
  });
});
