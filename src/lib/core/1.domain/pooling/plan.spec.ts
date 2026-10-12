import type { SharedExternal, shareScope } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { buildPools } from './membership';
import { planElection, type ElectionPlan } from './plan';
import { hasPoolResults } from './pool-state';

// Wraps the real `buildPools` so a test can tell whether the plan built the pool graph at all.
vi.mock('./membership', async importOriginal => {
  const actual = await importOriginal<typeof import('./membership')>();
  return { ...actual, buildPools: vi.fn(actual.buildPools) };
});

// The plan reads names, `pool` labels, `dirty` and pool results; one version per record suffices.
const record = (
  o: { dirty?: boolean; pool?: string; poolName?: string; servedBy?: string } = {}
): SharedExternal => ({
  dirty: o.dirty ?? false,
  ...(o.poolName === undefined ? {} : { poolName: o.poolName, poolWinner: 'team/a' }),
  versions: [
    {
      tag: '1.0.0',
      host: false,
      action: 'skip',
      remotes: [
        mockVersionRemote('team/a', 'x', {
          ...(o.pool === undefined ? {} : { pool: o.pool }),
          ...(o.servedBy === undefined ? {} : { servedBy: o.servedBy }),
        }),
      ],
    },
  ],
});

const shape = (plan: ElectionPlan) => ({
  pools: [...plan.pools].map(([name, members]) => [name, members.map(m => m.name)]),
  stripped: [...plan.stripped.keys()],
  labelledAlone: plan.labelledAlone,
});

const EMPTY = { pools: [], stripped: [], labelledAlone: [] };

describe('planElection', () => {
  beforeEach(() => {
    vi.mocked(buildPools).mockClear();
  });

  it('is empty, and builds no graph, when nothing in the scope is dirty', () => {
    // Stale pool results and a lone label are both left alone: a clean scope is what storage holds.
    const scope: shareScope = {
      a: record({ pool: 'g', poolName: 'g' }),
      b: record({ pool: 'g', poolName: 'g' }),
      stale: record({ poolName: 'gone' }),
      alone: record({ pool: 'typo' }),
    };

    expect(shape(planElection(scope, true))).toEqual(EMPTY);
    expect(buildPools).not.toHaveBeenCalled();
  });

  it('is empty, and builds no graph, for a scope without pool state', () => {
    const scope: shareScope = { a: record({ dirty: true }), b: record() };

    expect(shape(planElection(scope, true))).toEqual(EMPTY);
    expect(buildPools).not.toHaveBeenCalled();
  });

  it('pools nothing in a scope that is not poolable (the strict scope)', () => {
    const scope: shareScope = {
      a: record({ dirty: true, pool: 'g' }),
      b: record({ pool: 'g' }),
      stale: record({ poolName: 'gone' }),
    };

    expect(shape(planElection(scope, false))).toEqual(EMPTY);
    expect(buildPools).not.toHaveBeenCalled();
  });

  it('re-elects every pool of the scope when one member is dirty, clean pools included', () => {
    const scope: shareScope = {
      a: record({ dirty: true, pool: 'g' }),
      b: record({ pool: 'g', poolName: 'g' }),
      c: record({ pool: 'h', poolName: 'h' }),
      d: record({ pool: 'h', poolName: 'h' }),
    };

    const plan = planElection(scope, true);

    expect(shape(plan)).toEqual({
      ...EMPTY,
      pools: [
        ['g', ['a', 'b']],
        ['h', ['c', 'd']],
      ],
    });
    // Members are handed over as stored: the clean member is not marked dirty in the plan or the scope.
    expect(plan.pools.get('g')![1]!.external).toBe(scope['b']);
    expect(scope['b']!.dirty).toBe(false);
  });

  it('strips every external that left every pool and marks it dirty', () => {
    const scope: shareScope = {
      a: record({ dirty: true }),
      near: record({ poolName: 'g', servedBy: 'team/b' }),
      far: record({ poolName: 'k' }),
      plain: record(),
    };

    const plan = planElection(scope, true);

    expect([...plan.stripped.keys()]).toEqual(['near', 'far']);
    for (const external of plan.stripped.values()) {
      expect(hasPoolResults(external)).toBe(false);
      expect(external.dirty).toBe(true);
    }
    expect(plan.stripped.get('near')).toEqual({ ...record(), dirty: true });
  });

  it('lists a labelled external that pooled with nothing', () => {
    const scope: shareScope = { a: record({ dirty: true, pool: 'typo' }) };

    expect(shape(planElection(scope, true))).toEqual({ ...EMPTY, labelledAlone: ['a'] });
  });

  it('never writes to the scope it reads', () => {
    const scope: shareScope = {
      a: record({ dirty: true, pool: 'g' }),
      b: record({ pool: 'g', poolName: 'old' }),
      c: record({ pool: 'h', poolName: 'x' }),
      d: record({ pool: 'h' }),
      stale: record({ poolName: 'gone', servedBy: 'team/b' }),
    };
    const before = structuredClone(scope);

    planElection(scope, true);

    expect(scope).toStrictEqual(before);
  });

  it('does not depend on the order of the scope keys', () => {
    const entries: [string, SharedExternal][] = [
      ['a', record({ dirty: true, pool: 'g' })],
      ['b', record({ pool: 'g' })],
      ['c', record({ pool: 'h', poolName: 'x' })],
      ['d', record({ pool: 'h' })],
      ['stale', record({ poolName: 'gone' })],
    ];
    const sorted = (plan: ElectionPlan) => {
      const s = shape(plan);
      return { ...s, pools: s.pools.sort(), stripped: s.stripped.sort() };
    };

    expect(sorted(planElection(Object.fromEntries([...entries].reverse()), true))).toEqual(
      sorted(planElection(Object.fromEntries(entries), true))
    );
  });
});
