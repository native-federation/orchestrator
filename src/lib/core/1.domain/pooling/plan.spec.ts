import type { SharedExternal, shareScope } from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { buildPools } from './membership';
import { planElection, renamedRecords, renamesOf, type ElectionPlan } from './plan';
import { hasPoolResults } from './pool-state';

// Wraps the real `buildPools` so a test can tell whether the plan built the pool graph at all.
vi.mock('./membership', async importOriginal => {
  const actual = await importOriginal<typeof import('./membership')>();
  return { ...actual, buildPools: vi.fn(actual.buildPools) };
});

// The plan reads names, `pool` tags, `dirty` and pool results; one version per record suffices.
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
  dirtyPools: [...plan.dirtyPools].map(([name, members]) => [name, members.map(m => m.name)]),
  dissolved: [...plan.dissolved.keys()],
  renames: plan.renames,
  taggedAlone: plan.taggedAlone,
});

const EMPTY = { dirtyPools: [], dissolved: [], renames: [], taggedAlone: [] };

describe('planElection', () => {
  beforeEach(() => {
    vi.mocked(buildPools).mockClear();
  });

  it('is empty, and builds no graph, when nothing in the scope is dirty', () => {
    // Stale pool results and a lonely tag are both left alone: a clean scope is what storage holds.
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

  it('re-elects a pool whole when one member is dirty, and leaves a clean pool out of it', () => {
    const scope: shareScope = {
      a: record({ dirty: true, pool: 'g' }),
      b: record({ pool: 'g', poolName: 'g' }),
      c: record({ pool: 'h', poolName: 'h' }),
      d: record({ pool: 'h', poolName: 'h' }),
    };

    const plan = planElection(scope, true);

    expect(shape(plan)).toEqual({ ...EMPTY, dirtyPools: [['g', ['a', 'b']]] });
    // Members are handed over as stored: the clean member is not marked dirty in the plan or the scope.
    expect(plan.dirtyPools.get('g')![1]!.external).toBe(scope['b']);
    expect(scope['b']!.dirty).toBe(false);
  });

  it('re-elects a clean pool that a dirty external reaches through a stored poolName', () => {
    // `x` now pools alone with nobody, but stored `g` with b and c: the spread (reelection.spec.ts) drags the
    // pool it left into re-election.
    const scope: shareScope = {
      x: record({ dirty: true, poolName: 'g' }),
      b: record({ pool: 'g', poolName: 'g' }),
      c: record({ pool: 'g', poolName: 'g' }),
    };

    expect(shape(planElection(scope, true)).dirtyPools).toEqual([['g', ['b', 'c']]]);
  });

  it('strips every external that left every pool and marks it dirty, reached by the spread or not', () => {
    // `far` stored a pool name nothing dirty shares: it is stripped anyway, scope-wide.
    const scope: shareScope = {
      a: record({ dirty: true }),
      near: record({ poolName: 'g', servedBy: 'team/b' }),
      far: record({ poolName: 'k' }),
      plain: record(),
    };

    const plan = planElection(scope, true);

    expect([...plan.dissolved.keys()]).toEqual(['near', 'far']);
    for (const external of plan.dissolved.values()) {
      expect(hasPoolResults(external)).toBe(false);
      expect(external.dirty).toBe(true);
    }
    expect(plan.dissolved.get('near')).toEqual({ ...record(), dirty: true });
  });

  it("renames a clean pool's member whose stored poolName is not the computed one", () => {
    const scope: shareScope = {
      a: record({ dirty: true, pool: 'g' }),
      b: record({ pool: 'g' }),
      c: record({ pool: 'h', poolName: 'old' }),
      d: record({ pool: 'h', poolName: 'h' }),
    };

    // The dirty pool is renamed by its election, not here.
    expect(shape(planElection(scope, true)).renames).toEqual([['c', 'h']]);
  });

  it('lists a tagged external that pooled with nothing', () => {
    const scope: shareScope = { a: record({ dirty: true, pool: 'typo' }) };

    expect(shape(planElection(scope, true))).toEqual({ ...EMPTY, taggedAlone: ['a'] });
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

    expect(scope).toEqual(before);
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
      return { ...s, dissolved: s.dissolved.sort(), renames: s.renames.sort() };
    };

    expect(sorted(planElection(Object.fromEntries([...entries].reverse()), true))).toEqual(
      sorted(planElection(Object.fromEntries(entries), true))
    );
  });
});

describe('renamesOf', () => {
  const pool = (scope: shareScope, ...names: string[]) =>
    names.map(name => ({ name, external: scope[name]! }));

  // A dynamic load writes the pools it judged; one it merged renames committed members it never rewrote.
  it('names a member that stored no pool yet, and skips one already named right', () => {
    const scope: shareScope = { core: record({ poolName: 'framework' }), common: record() };

    expect(renamesOf(scope, new Map([['framework', pool(scope, 'core', 'common')]]))).toEqual([
      ['common', 'framework'],
    ]);
  });

  it('renames a member stored under another name, and nothing in no pool', () => {
    const scope: shareScope = {
      '@framework/core': record({ poolName: 'old' }),
      stale: record({ poolName: 'gone' }),
    };

    expect(renamesOf(scope, new Map([['angular', pool(scope, '@framework/core')]]))).toEqual([
      ['@framework/core', 'angular'],
    ]);
  });

  it('reads the stored name from the scope, not from the member it was handed', () => {
    // The dynamic path passes the committed records merged with what it just wrote.
    const before = record({ poolName: 'old' });
    const scope: shareScope = { a: record({ poolName: 'p' }) };

    expect(renamesOf(scope, new Map([['p', [{ name: 'a', external: before }]]]))).toEqual([]);
  });
});

describe('renamedRecords', () => {
  const pooled = (poolName?: string): SharedExternal => ({
    dirty: false,
    ...(poolName === undefined ? {} : { poolName }),
    poolWinner: 'team/a',
    versions: [
      {
        tag: '17.0.0',
        host: false,
        action: 'skip',
        remotes: [mockVersionRemote('team/b', '@framework/core', { servedBy: 'team/c' })],
      },
    ],
  });

  it('keeps poolWinner and servedBy on a rename: the pool was not re-elected', () => {
    const record = pooled('framework');

    expect(renamedRecords({ '@framework/core': record }, [['@framework/core', 'angular']])).toEqual(
      [['@framework/core', { ...pooled('framework'), poolName: 'angular' }]]
    );
    expect(record).toEqual(pooled('framework'));
  });
});
