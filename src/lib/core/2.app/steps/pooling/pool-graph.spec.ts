import type { SharedExternal, shareScope } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { createMockLogHandler } from 'lib/testing/handlers/log.handler';
import { buildPools } from './pool-graph';
import type { PoolMember, PoolName } from './pool.types';

// buildPools reads only the external name and each remote's name + pool tag — one skip version suffices.
const ext = (remotes: { remote: string; pool?: string }[]): SharedExternal => ({
  dirty: false,
  versions: [
    {
      tag: '1.0.0',
      host: false,
      action: 'skip',
      remotes: remotes.map(r => mockVersionRemote(r.remote, 'x', { pool: r.pool })),
    },
  ],
});

const scope = (entries: Record<string, { remote: string; pool?: string }[]>): shareScope =>
  Object.fromEntries(Object.entries(entries).map(([name, rs]) => [name, ext(rs)]));

const shape = (pools: Map<PoolName, PoolMember[]>): [PoolName, string[]][] =>
  [...pools.entries()].map(([name, members]) => [name, members.map(m => m.name)]);

describe('buildPools', () => {
  // Formerly "auto-pooling (by npm scope, per declaring remote)". The build now writes the scope as an
  // explicit tag, so the same portfolios are expressed with `pool: 'ng'` on every copy; the per-remote
  // property they pinned is simply the remote-locality of tag nodes.
  describe('scope-derived tags (what the build emits by default)', () => {
    it('does NOT pool one tag across remotes that share no member', () => {
      const pools = buildPools(
        scope({
          '@ng/core': [{ remote: 'a', pool: 'ng' }],
          '@ng/common': [{ remote: 'b', pool: 'ng' }],
        })
      );
      expect(pools.size).toBe(0);
    });

    it('pools as soon as one remote declares two tagged members', () => {
      const pools = buildPools(
        scope({
          '@ng/core': [{ remote: 'a', pool: 'ng' }],
          '@ng/common': [{ remote: 'a', pool: 'ng' }],
        })
      );
      expect(shape(pools)).toEqual([['ng', ['@ng/common', '@ng/core']]]);
    });

    // The witness need not consume the whole pool: one remote bridging a pair is enough to pull in
    // every other remote's copies of those members.
    it('pulls other remotes in through the member a witness shares with them', () => {
      const pools = buildPools(
        scope({
          '@ng/core': [
            { remote: 'a', pool: 'ng' },
            { remote: 'b', pool: 'ng' },
          ],
          '@ng/common': [{ remote: 'b', pool: 'ng' }],
          '@ng/forms': [{ remote: 'c', pool: 'ng' }],
        })
      );
      // b declares core+common, so those pool; c's forms sits alone on its own `(c, ng)` node.
      expect(shape(pools)).toEqual([['ng', ['@ng/common', '@ng/core']]]);
    });

    it('is inert without tags', () => {
      const pools = buildPools(
        scope({ '@ng/core': [{ remote: 'a' }], '@ng/common': [{ remote: 'a' }] })
      );
      expect(pools.size).toBe(0);
    });
  });

  describe('explicit tags (remote-local, bridge by shared member)', () => {
    it('merges tag groups with different labels through a shared member', () => {
      // mfe1 tags {core, ui}="ng"; mfe2 tags {ui, forms}="ds". ui bridges them despite the labels differing.
      const pools = buildPools(
        scope({
          '@x/core': [{ remote: 'mfe1', pool: 'ng' }],
          '@x/ui': [
            { remote: 'mfe1', pool: 'ng' },
            { remote: 'mfe2', pool: 'ds' },
          ],
          '@x/forms': [{ remote: 'mfe2', pool: 'ds' }],
        })
      );
      // Two declarations each: the tie goes to the alphabetically first label.
      expect(shape(pools)).toEqual([['ds', ['@x/core', '@x/forms', '@x/ui']]]);
    });

    it('does NOT merge same-labelled groups that share no member', () => {
      // Both remotes use the label "x", but the member sets are disjoint — identical labels are not evidence.
      // They still need distinct names, so the pool with the larger smallest member is suffixed.
      const pools = buildPools(
        scope({
          core: [{ remote: 'mfe1', pool: 'x' }],
          ui: [{ remote: 'mfe1', pool: 'x' }],
          forms: [{ remote: 'mfe2', pool: 'x' }],
          bar: [{ remote: 'mfe2', pool: 'x' }],
        })
      );
      expect(shape(pools)).toEqual([
        ['x', ['bar', 'forms']],
        ['x~2', ['core', 'ui']],
      ]);
    });

    it('bridges a co-tagged cross-scope member into the family', () => {
      const pools = buildPools(
        scope({
          '@ng/core': [
            { remote: 'mfe1', pool: 'ng' },
            { remote: 'mfe2', pool: 'ng' },
          ],
          '@ng/common': [{ remote: 'mfe2', pool: 'ng' }],
          '@design/ui': [{ remote: 'mfe1', pool: 'ng' }],
        })
      );
      expect(shape(pools)).toEqual([['ng', ['@design/ui', '@ng/common', '@ng/core']]]);
    });
  });

  describe('naming', () => {
    it('names a pool after the tag most copies declare', () => {
      // "ng" is declared three times, "ds" once; the alphabetical order would have picked "ds".
      const pools = buildPools(
        scope({
          '@ng/core': [
            { remote: 'mfe1', pool: 'ng' },
            { remote: 'mfe2', pool: 'ng' },
          ],
          '@ng/common': [{ remote: 'mfe1', pool: 'ng' }],
          '@design/ui': [
            { remote: 'mfe2', pool: 'ds' },
            { remote: 'mfe2', pool: 'ng' },
          ],
        })
      );
      expect([...pools.keys()]).toEqual(['ng']);
    });

    it('breaks a count tie alphabetically', () => {
      const pools = buildPools(
        scope({
          a: [{ remote: 'mfe1', pool: 'zeta' }],
          b: [
            { remote: 'mfe1', pool: 'zeta' },
            { remote: 'mfe2', pool: 'alpha' },
          ],
          c: [{ remote: 'mfe2', pool: 'alpha' }],
        })
      );
      expect([...pools.keys()]).toEqual(['alpha']);
    });

    // The suffix order follows each pool's smallest member, not input order, so it is reload-stable.
    it('suffixes pools sharing a tag in order of their smallest member, whatever the input order', () => {
      const members = {
        '@ng/router': [{ remote: 'b', pool: 'ng' }],
        '@ng/forms': [{ remote: 'b', pool: 'ng' }],
        '@ng/core': [{ remote: 'a', pool: 'ng' }],
        '@ng/common': [{ remote: 'a', pool: 'ng' }],
        '@ng/animations': [{ remote: 'c', pool: 'ng' }],
        '@ng/zone': [{ remote: 'c', pool: 'ng' }],
      };
      const expected = [
        ['ng', ['@ng/animations', '@ng/zone']],
        ['ng~2', ['@ng/common', '@ng/core']],
        ['ng~3', ['@ng/forms', '@ng/router']],
      ];
      expect(shape(buildPools(scope(members)))).toEqual(expected);

      const reversed = Object.fromEntries(Object.entries(members).reverse());
      expect(shape(buildPools(scope(reversed)))).toEqual(expected);
    });
  });

  describe('secondary entrypoints follow their package', () => {
    // A flat build that tags only the package would otherwise leave its entrypoints out of pooling —
    // measured as a torn @ng/core.
    it('pulls an untagged entrypoint into its tagged package’s pool', () => {
      const pools = buildPools(
        scope({
          '@ng/core': [{ remote: 'mfe1', pool: 'ng' }],
          '@ng/core/primitives/di': [{ remote: 'mfe1' }],
          '@design/ui': [{ remote: 'mfe1', pool: 'ng' }],
        })
      );
      expect(shape(pools)).toEqual([['ng', ['@design/ui', '@ng/core', '@ng/core/primitives/di']]]);
    });

    // The package and its own entrypoints are a pool even across remotes: they are exactly the pair
    // that tears when one remote's `@ng/forms` is served beside another's `@ng/forms/signals`.
    it('pools an entrypoint with its package across remotes, unscoped names included', () => {
      const pools = buildPools(
        scope({ rxjs: [{ remote: 'mfe1' }], 'rxjs/operators': [{ remote: 'mfe2', pool: 'rx' }] })
      );
      expect(shape(pools)).toEqual([['rx', ['rxjs', 'rxjs/operators']]]);
    });

    // An entrypoint edge is not itself a reason to pool.
    it('forms no pool from a package and its entrypoint when nothing is tagged', () => {
      const pools = buildPools(
        scope({ utils: [{ remote: 'a' }], 'utils/deep': [{ remote: 'a' }] })
      );
      expect(pools.size).toBe(0);
    });
  });

  describe('singletons', () => {
    it('warns when a tag pools with nothing (likely typo/missing sibling)', () => {
      const log = createMockLogHandler('debug');
      const pools = buildPools(scope({ '@a/solo': [{ remote: 'mfe1', pool: 'z' }] }), log);
      expect(pools.size).toBe(0);
      expect(log.warn).toHaveBeenCalledOnce();
    });
  });

  describe('determinism', () => {
    it('names and orders pools the same whatever the input order', () => {
      const members = {
        '@ng/core': [{ remote: 'a', pool: 'ng' }],
        '@ng/common': [{ remote: 'a', pool: 'ng' }],
        '@ng/forms': [{ remote: 'a', pool: 'ng' }],
      };
      const forward = buildPools(scope(members));
      const shuffled = buildPools(
        scope({
          '@ng/forms': members['@ng/forms'],
          '@ng/core': members['@ng/core'],
          '@ng/common': members['@ng/common'],
        })
      );
      expect(shape(forward)).toEqual([['ng', ['@ng/common', '@ng/core', '@ng/forms']]]);
      expect(shape(shuffled)).toEqual(shape(forward));
    });
  });
});
