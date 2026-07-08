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
  describe('auto-pooling (by npm scope, global)', () => {
    it('groups scoped packages by scope without needing a shared member', () => {
      const pools = buildPools(
        scope({ '@ng/core': [{ remote: 'a' }], '@ng/common': [{ remote: 'b' }] }),
        true
      );
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

  describe('tag/scope interaction (strict — no merge by name)', () => {
    it('joins a tag group into a scope pool only via a co-tagged bridge member', () => {
      // core is auto-scoped AND co-tagged "ng"; that co-tag bridges @design/ui into the framework family.
      const pools = buildPools(
        scope({
          '@ng/core': [{ remote: 'mfe1', pool: 'ng' }],
          '@ng/common': [{ remote: 'mfe2' }],
          '@design/ui': [{ remote: 'mfe1', pool: 'ng' }],
        }),
        true
      );
      expect(shape(pools)).toEqual([
        ['@design/ui', ['@design/ui', '@ng/common', '@ng/core']],
      ]);
    });

    it('does NOT merge a tag into a same-named scope without a bridge', () => {
      // @design/ui tags "ng" but no framework member is co-tagged: the string match must not merge it.
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
      expect(shape(pools)).toEqual([['@ng/common', ['@ng/common', '@ng/core']]]);
      expect(log.warn).toHaveBeenCalledOnce(); // @design/ui pooled with nothing
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
    it('keys each pool by its smallest member and is stable across input order', () => {
      const forward = buildPools(
        scope({ '@ng/core': [{ remote: 'a' }], '@ng/common': [{ remote: 'b' }], '@ng/forms': [{ remote: 'c' }] }),
        true
      );
      const shuffled = buildPools(
        scope({ '@ng/forms': [{ remote: 'c' }], '@ng/core': [{ remote: 'a' }], '@ng/common': [{ remote: 'b' }] }),
        true
      );
      expect(shape(forward)).toEqual([['@ng/common', ['@ng/common', '@ng/core', '@ng/forms']]]);
      expect(shape(shuffled)).toEqual(shape(forward));
    });
  });
});
