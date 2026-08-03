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
  describe('auto-pooling (by npm scope, per declaring remote)', () => {
    // REWRITTEN. This used to assert the opposite — one global node per npm scope pooled `@ng/*`
    // whether or not any remote shipped two of them. The auto-scope node is now per `(remote, scope)`,
    // exactly as a tag node is per `(remote, tag)`, so a pool forms only when some remote declares
    // members from both sides. Two remotes that share no member already satisfy the provenance
    // promise — neither can run an incoherent pair — so pooling them bought nothing and cost the
    // agreement gate a vacuous comparison it was unsound to treat as safe. See
    // docs/version-resolver.md §"The provenance promise", the auto-pooling bullet.
    it('does NOT pool one scope across remotes that share no member', () => {
      const pools = buildPools(
        scope({ '@ng/core': [{ remote: 'a' }], '@ng/common': [{ remote: 'b' }] }),
        true
      );
      expect(pools.size).toBe(0);
    });

    it('pools a scope as soon as one remote declares two of its members', () => {
      const pools = buildPools(
        scope({ '@ng/core': [{ remote: 'a' }], '@ng/common': [{ remote: 'a' }] }),
        true
      );
      expect(shape(pools)).toEqual([['@ng/common', ['@ng/common', '@ng/core']]]);
    });

    // The witness need not consume the whole pool: one remote bridging a pair is enough to pull in
    // every other remote's copies of those members, which is what keeps a tag on one remote able to
    // fix a portfolio it does not own.
    it('pulls other remotes in through the member a witness shares with them', () => {
      const pools = buildPools(
        scope({
          '@ng/core': [{ remote: 'a' }, { remote: 'b' }],
          '@ng/common': [{ remote: 'b' }],
          '@ng/forms': [{ remote: 'c' }],
        }),
        true
      );
      // b declares core+common, so those pool; c's forms is alone in its own scope node.
      expect(shape(pools)).toEqual([['@ng/common', ['@ng/common', '@ng/core']]]);
    });

    it('is inert when auto-pooling is off', () => {
      const pools = buildPools(
        scope({ '@ng/core': [{ remote: 'a' }], '@ng/common': [{ remote: 'b' }] }),
        false
      );
      expect(pools.size).toBe(0);
    });

    it('never auto-pools unscoped packages', () => {
      const pools = buildPools(scope({ utils: [{ remote: 'a' }], tslib: [{ remote: 'b' }] }), true);
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
        }),
        false
      );
      expect(shape(pools)).toEqual([['@x/core', ['@x/core', '@x/forms', '@x/ui']]]);
    });

    it('does NOT merge same-labelled groups that share no member', () => {
      // Both remotes use the label "x", but the member sets are disjoint — identical labels are not evidence.
      const pools = buildPools(
        scope({
          core: [{ remote: 'mfe1', pool: 'x' }],
          ui: [{ remote: 'mfe1', pool: 'x' }],
          forms: [{ remote: 'mfe2', pool: 'x' }],
          bar: [{ remote: 'mfe2', pool: 'x' }],
        }),
        false
      );
      expect(shape(pools)).toEqual([
        ['bar', ['bar', 'forms']],
        ['core', ['core', 'ui']],
      ]);
    });
  });

  describe('tag/scope interaction (a tag replaces auto-pooling for its remote)', () => {
    // REWRITTEN. The bridge still works — the co-tag joins @design/ui to @ng/core — but @ng/common no
    // longer comes with it. mfe1 tagged inside both scopes, so mfe1 contributes no auto edge for
    // either, and mfe2's @ng/common sits on its own `(mfe2, ng)` node with no member shared with
    // mfe1. That is the point of the rule: one tag on a design-system package must not drag every
    // unrelated package of the scope in behind it, which is what made coverage scarce enough to
    // double the self-serving population.
    it('bridges a co-tagged member into the tag group without dragging in the whole scope', () => {
      const pools = buildPools(
        scope({
          '@ng/core': [{ remote: 'mfe1', pool: 'ng' }],
          '@ng/common': [{ remote: 'mfe2' }],
          '@design/ui': [{ remote: 'mfe1', pool: 'ng' }],
        }),
        true
      );
      expect(shape(pools)).toEqual([['@design/ui', ['@design/ui', '@ng/core']]]);
    });

    // The scope still reaches the tag group when a remote genuinely witnesses the pair.
    it('reaches the rest of the scope through a remote that declares both', () => {
      const pools = buildPools(
        scope({
          '@ng/core': [{ remote: 'mfe1', pool: 'ng' }, { remote: 'mfe2' }],
          '@ng/common': [{ remote: 'mfe2' }],
          '@design/ui': [{ remote: 'mfe1', pool: 'ng' }],
        }),
        true
      );
      // mfe2 declares core+common untagged, so its auto edges hold the scope open and the co-tag
      // still carries @design/ui in.
      expect(shape(pools)).toEqual([
        ['@design/ui', ['@design/ui', '@ng/common', '@ng/core']],
      ]);
    });

    // REWRITTEN. Unchanged in its point — a tag never merges into a same-named scope by string — but
    // @ng/core and @ng/common no longer pool with each other either, for the reason above: mfe1 and
    // mfe2 share no member. @design/ui is still the tagged singleton that gets warned.
    it('does NOT merge a tag into a same-named scope without a bridge', () => {
      const log = createMockLogHandler('debug');
      const pools = buildPools(
        scope({
          '@ng/core': [{ remote: 'mfe1' }],
          '@ng/common': [{ remote: 'mfe2' }],
          '@design/ui': [{ remote: 'mfe1', pool: 'ng' }],
        }),
        true,
        log
      );
      expect(pools.size).toBe(0);
      expect(log.warn).toHaveBeenCalledOnce(); // @design/ui pooled with nothing
    });
  });

  describe('secondary entrypoints follow their package', () => {
    // An entrypoint contributes no edge of its own once its remote has tagged inside the scope, so
    // without the package edge it would leave pooling entirely — measured as a torn @ng/core, with
    // the capture looking cheaper only because the guarantee had shrunk.
    it('keeps a flat entrypoint with its package when a tag suppresses the auto edge', () => {
      const pools = buildPools(
        scope({
          '@ng/core': [{ remote: 'mfe1', pool: 'ng' }],
          '@ng/core/primitives/di': [{ remote: 'mfe1' }],
          '@design/ui': [{ remote: 'mfe1', pool: 'ng' }],
        }),
        true
      );
      expect(shape(pools)).toEqual([
        ['@design/ui', ['@design/ui', '@ng/core', '@ng/core/primitives/di']],
      ]);
    });

    // The package and its own entrypoints are a pool even across remotes: they are exactly the pair
    // that tears when one remote's `@ng/forms` is served beside another's `@ng/forms/signals`.
    it('pools an entrypoint with its package across remotes, unscoped names included', () => {
      const pools = buildPools(
        scope({ rxjs: [{ remote: 'mfe1' }], 'rxjs/operators': [{ remote: 'mfe2', pool: 'rx' }] }),
        true
      );
      expect(shape(pools)).toEqual([['rxjs', ['rxjs', 'rxjs/operators']]]);
    });

    // Pooling stays inert: an entrypoint edge is not itself a reason to pool.
    it('forms no pool from a package and its entrypoint when nothing joined', () => {
      const pools = buildPools(
        scope({ utils: [{ remote: 'a' }], 'utils/deep': [{ remote: 'a' }] }),
        true
      );
      expect(pools.size).toBe(0);
    });
  });

  describe('singletons', () => {
    it('warns when an explicit tag pools with nothing (likely typo/missing sibling)', () => {
      const log = createMockLogHandler('debug');
      const pools = buildPools(scope({ '@a/solo': [{ remote: 'mfe1', pool: 'z' }] }), false, log);
      expect(pools.size).toBe(0);
      expect(log.warn).toHaveBeenCalledOnce();
    });

    it('stays silent for an auto-scope singleton (normal in ragged portfolios)', () => {
      const log = createMockLogHandler('debug');
      const pools = buildPools(scope({ '@ng/core': [{ remote: 'a' }] }), true, log);
      expect(pools.size).toBe(0);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe('determinism', () => {
    // REWRITTEN on shape, not on naming: the three members used to come from three different remotes,
    // which forms no pool at all now. One remote declaring all three is the portfolio that still
    // exercises what this test is about — the canonical name and the input-order stability.
    it('keys each pool by its smallest member and is stable across input order', () => {
      const members = {
        '@ng/core': [{ remote: 'a' }],
        '@ng/common': [{ remote: 'a' }],
        '@ng/forms': [{ remote: 'a' }],
      };
      const forward = buildPools(scope(members), true);
      const shuffled = buildPools(
        scope({
          '@ng/forms': members['@ng/forms'],
          '@ng/core': members['@ng/core'],
          '@ng/common': members['@ng/common'],
        }),
        true
      );
      expect(shape(forward)).toEqual([['@ng/common', ['@ng/common', '@ng/core', '@ng/forms']]]);
      expect(shape(shuffled)).toEqual(shape(forward));
    });
  });
});
