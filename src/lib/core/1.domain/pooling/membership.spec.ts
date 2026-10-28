import type { SharedExternal, shareScope } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { packageOfIn } from 'lib/core/1.domain/externals/specifier';
import {
  buildPools,
  type LabelledCopy,
  pooledPackagesWith,
  type PoolMember,
  type PoolName,
} from './membership';

// buildPools reads only the external name and each remote's name + pool label — one skip version suffices.
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
  // The build writes the npm scope as an explicit label by default, so these portfolios carry `pool: 'ng'` on
  // every copy. A name is a pool's identity across remotes, not a per-remote label.
  describe('scope-derived labels (what the build emits by default)', () => {
    it('pools one name across remotes even when they share no member', () => {
      // a and b share no member: the name alone says core and common belong together, whoever declared it.
      const { pools } = buildPools(
        scope({
          '@ng/core': [{ remote: 'a', pool: 'ng' }],
          '@ng/common': [{ remote: 'b', pool: 'ng' }],
        })
      );
      expect(shape(pools)).toEqual([['ng', ['@ng/common', '@ng/core']]]);
    });

    it('is inert without labels', () => {
      const { pools } = buildPools(
        scope({ '@ng/core': [{ remote: 'a' }], '@ng/common': [{ remote: 'a' }] })
      );
      expect(pools.size).toBe(0);
    });
  });

  describe('explicit labels (one pool per label, labels merge through a shared member)', () => {
    it('merges groups with different labels through a shared member', () => {
      // mfe1 labels {core, ui}="ng"; mfe2 labels {ui, forms}="ds". ui bridges them despite the labels differing.
      const { pools } = buildPools(
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

    it('bridges a co-labelled cross-scope member into the family', () => {
      const { pools } = buildPools(
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

  // The pool label is trimmed before it is compared: a padded label is the same pool as its trimmed twin.
  it('pools a padded label with the same label unpadded', () => {
    const { pools } = buildPools(
      scope({
        a: [{ remote: 'mfe1', pool: ' x' }],
        b: [{ remote: 'mfe2', pool: 'x' }],
      })
    );
    expect(shape(pools)).toEqual([['x', ['a', 'b']]]);
  });

  describe('naming', () => {
    it('names a pool after the label most copies declare', () => {
      // "ng" is declared three times, "ds" once; the alphabetical order would have picked "ds".
      const { pools } = buildPools(
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
      const { pools } = buildPools(
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
  });

  describe('secondary entrypoints follow their package', () => {
    // A flat build that labels only the package would otherwise leave its entrypoints out of pooling —
    // measured as a torn @ng/core.
    it('pulls an unlabelled entrypoint into its labelled package’s pool', () => {
      const { pools } = buildPools(
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
      const { pools } = buildPools(
        scope({ rxjs: [{ remote: 'mfe1' }], 'rxjs/operators': [{ remote: 'mfe2', pool: 'rx' }] })
      );
      expect(shape(pools)).toEqual([['rx', ['rxjs', 'rxjs/operators']]]);
    });

    // A package can ship entrypoints only (`@m/material/table`, no root external): its entrypoints still join
    // through the package, or a labelled one would pool while its unlabelled sibling stays out, and the two
    // externals of one package would get two serving builds.
    it('pools the entrypoints of a package that has no root external', () => {
      const { pools } = buildPools(
        scope({
          '@m/material/table': [{ remote: 'w', pool: 'ng' }],
          '@ng/forms': [{ remote: 'w', pool: 'ng' }],
          '@m/material/button': [{ remote: 'x' }],
        })
      );
      expect(shape(pools)).toEqual([
        ['ng', ['@m/material/button', '@m/material/table', '@ng/forms']],
      ]);
    });

    // The package's node is no label: unlabelled entrypoints of a root-less package form no pool either.
    it('forms no pool from unlabelled entrypoints of a root-less package', () => {
      const { pools, labelledAlone } = buildPools(
        scope({ '@m/material/table': [{ remote: 'w' }], '@m/material/button': [{ remote: 'x' }] })
      );
      expect(pools.size).toBe(0);
      expect(labelledAlone).toEqual([]);
    });

    // An entrypoint edge is not itself a reason to pool.
    it('forms no pool from a package and its entrypoint when nothing is labelled', () => {
      const { pools } = buildPools(
        scope({ utils: [{ remote: 'a' }], 'utils/deep': [{ remote: 'a' }] })
      );
      expect(pools.size).toBe(0);
    });
  });

  describe('determinism', () => {
    // Nothing reads the order of pools but the logs; it follows the record, not the members' names.
    it('keeps pools in the record order of their first member', () => {
      const pools = buildPools(
        scope({
          'z/core': [{ remote: 'a', pool: 'z' }],
          'a/core': [{ remote: 'a', pool: 'a' }],
          'z/common': [{ remote: 'a', pool: 'z' }],
          'a/common': [{ remote: 'a', pool: 'a' }],
        })
      ).pools;
      expect(shape(pools)).toEqual([
        ['z', ['z/common', 'z/core']],
        ['a', ['a/common', 'a/core']],
      ]);
    });

    it('names a pool and orders its members the same whatever the input order', () => {
      const members = {
        '@ng/core': [{ remote: 'a', pool: 'ng' }],
        '@ng/common': [{ remote: 'a', pool: 'ng' }],
        '@ng/forms': [{ remote: 'a', pool: 'ng' }],
      };
      const forward = buildPools(scope(members)).pools;
      const shuffled = buildPools(
        scope({
          '@ng/forms': members['@ng/forms'],
          '@ng/core': members['@ng/core'],
          '@ng/common': members['@ng/common'],
        })
      ).pools;
      expect(shape(forward)).toEqual([['ng', ['@ng/common', '@ng/core', '@ng/forms']]]);
      expect(shape(shuffled)).toEqual(shape(forward));
    });
  });

  // Typed DeepReadonly, so this pins the runtime side: the members it hands out are the scope's own records.
  it('never writes to the scope it reads', () => {
    const input = scope({
      '@ng/forms': [{ remote: 'b', pool: ' ng' }],
      '@ng/core': [
        { remote: 'a', pool: 'ng' },
        { remote: 'b', pool: 'ui' },
      ],
      '@ng/core/testing': [{ remote: 'a' }],
      lonely: [{ remote: 'a', pool: 'typo' }],
      plain: [{ remote: 'a' }],
    });
    // A second version, so a reordering write shows.
    input['plain']!.versions.push({ ...input['plain']!.versions[0]!, tag: '0.9.0' });
    const before = structuredClone(input);

    const { pools, labelledAlone } = buildPools(input);

    expect(input).toStrictEqual(before);
    expect(Object.keys(input)).toEqual(Object.keys(before));
    expect(shape(pools)).toEqual([['ng', ['@ng/core', '@ng/core/testing', '@ng/forms']]]);
    expect(labelledAlone).toEqual(['lonely']);
  });
});

// update-cache asks which packages are pooled before the load's copies are stored; the gate builds pools after.
// pooledPackagesWith must answer what buildPools answers over the record with the copies stored, whatever row
// the copies land in.
describe('pooledPackagesWith', () => {
  const stored = (record: shareScope, copies: LabelledCopy[]): shareScope => {
    const out = structuredClone(record);
    for (const { name, pool } of copies) {
      const external = (out[name] ??= { dirty: false, versions: [] });
      external.versions.push({
        tag: '9.0.0',
        host: false,
        action: 'scope',
        remotes: [mockVersionRemote('loader', 'x', { pool })],
      });
    }
    return out;
  };
  const pooledOnceStored = (record: shareScope, copies: LabelledCopy[]) => {
    const packageOf = packageOfIn(stored(record, copies));
    return new Set(
      [...buildPools(stored(record, copies)).pools.values()].flatMap(members =>
        members.map(m => packageOf(m.name))
      )
    );
  };

  // Each record's labels sit on a `skip` row (see `ext`), so a label off the share rows counts too.
  const cases: Record<string, { record: shareScope; copies: LabelledCopy[]; pooled: string[] }> = {
    'a lone label forms no pool': {
      record: scope({ p: [{ remote: 'a' }] }),
      copies: [{ name: 'p', pool: 'fw' }],
      pooled: [],
    },
    "a copy's label joins a lone label of the record": {
      record: scope({ p: [{ remote: 'a' }], q: [{ remote: 'a', pool: 'fw' }] }),
      copies: [{ name: 'p', pool: 'fw' }],
      pooled: ['p', 'q'],
    },
    'an unlabelled flat secondary turns a lone label of its package into a pool': {
      record: scope({ p: [{ remote: 'a', pool: 'fw' }] }),
      copies: [{ name: 'p/y' }],
      pooled: ['p'],
    },
    'a copy of an external the record lacks': {
      record: scope({ q: [{ remote: 'a', pool: 'fw' }] }),
      copies: [{ name: 'r', pool: 'fw' }],
      pooled: ['q', 'r'],
    },
    'pool results without a label pool nothing': {
      record: { p: { ...ext([{ remote: 'a' }]), poolName: 'fw', poolWinner: 'a' } },
      copies: [{ name: 'p' }],
      pooled: [],
    },
    "a copy's label merges two pools": {
      record: scope({
        p: [{ remote: 'a', pool: 'fw' }],
        p2: [{ remote: 'a', pool: 'fw' }],
        q: [{ remote: 'a', pool: 'ui' }],
        q2: [{ remote: 'a', pool: 'ui' }],
      }),
      copies: [{ name: 'p', pool: 'ui' }],
      pooled: ['p', 'p2', 'q', 'q2'],
    },
    'a padded label is the same label': {
      record: scope({ q: [{ remote: 'a', pool: 'fw' }] }),
      copies: [{ name: 'p', pool: ' fw ' }],
      pooled: ['p', 'q'],
    },
    'a rootless package pools through its owner': {
      record: scope({ '@x/a/s1': [{ remote: 'a', pool: 'fw' }] }),
      copies: [{ name: '@x/a/s2' }],
      pooled: ['@x/a'],
    },
    'one external copied twice is still alone': {
      record: {},
      copies: [
        { name: 'p', pool: 'fw' },
        { name: 'p', pool: 'fw' },
      ],
      pooled: [],
    },
  };

  for (const [name, { record, copies, pooled }] of Object.entries(cases))
    it(name, () => {
      const before = structuredClone(record);
      const actual = pooledPackagesWith(record, copies, packageOfIn(stored(record, copies)));
      expect(actual).toEqual(pooledOnceStored(record, copies));
      expect([...actual].sort()).toEqual(pooled);
      expect(record).toStrictEqual(before);
    });
});

describe('a dense library deeper than its npm name', () => {
  // Declared libraries under one npm name: the label on `@s/c/t` pools it with `@s/fw`, not `@s/c/u`.
  const library = (name: string, pool?: string): SharedExternal => ({
    dirty: false,
    versions: [
      {
        tag: '1.0.0',
        host: false,
        action: 'share',
        remotes: [{ ...mockVersionRemote('a', name, { pool }), dense: true }],
      },
    ],
  });
  const record: shareScope = {
    '@s/fw': library('@s/fw', 'ui'),
    '@s/c/t': library('@s/c/t', 'ui'),
    '@s/c/u': library('@s/c/u'),
  };

  it('pools the library the label is on, by its own name', () => {
    expect(shape(buildPools(record).pools)).toEqual([['ui', ['@s/c/t', '@s/fw']]]);
    expect([...pooledPackagesWith(record, [], packageOfIn(record))].sort()).toEqual([
      '@s/c/t',
      '@s/fw',
    ]);
  });
});
