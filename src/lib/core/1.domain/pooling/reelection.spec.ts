import type { SharedExternal, shareScope } from '../externals/external.contract';
import type { PoolMember } from './membership';
import { reelectedNames } from './reelection';

// Records carry only what the spread reads: `dirty` and the stored `poolName`. The computed pools are passed
// in as `buildPools` would hand them over, so each case states both partitions explicitly.
const record = (dirty: boolean, poolName?: string): SharedExternal => ({
  dirty,
  ...(poolName === undefined ? {} : { poolName }),
  versions: [],
});

const computed = (scope: shareScope, ...pools: string[][]): Map<string, PoolMember[]> =>
  new Map(
    pools.map((names, i) => [`pool${i}`, names.map(name => ({ name, external: scope[name]! }))])
  );

const sorted = (names: Set<string>) => [...names].sort();

describe('reelectedNames', () => {
  it('returns nothing for a scope with nothing dirty', () => {
    const scope = { a: record(false, 'P'), b: record(false, 'P') };

    expect(sorted(reelectedNames(scope, computed(scope, ['a', 'b'])))).toEqual([]);
  });

  it('returns a dirty external in no pool, and only that', () => {
    const scope = { lone: record(true), a: record(false, 'P'), b: record(false, 'P') };

    expect(sorted(reelectedNames(scope, computed(scope, ['a', 'b'])))).toEqual(['lone']);
  });

  it('spreads over a computed pool', () => {
    const scope = { a: record(true), b: record(false), c: record(false) };

    expect(sorted(reelectedNames(scope, computed(scope, ['a', 'b'])))).toEqual(['a', 'b']);
  });

  // A pool that split since it was stored: b and c no longer pool with a, but share its stored name.
  it('spreads over a stored pool name', () => {
    const scope = { a: record(true, 'P'), b: record(false, 'P'), c: record(false, 'P') };

    expect(sorted(reelectedNames(scope, computed(scope, ['b', 'c'])))).toEqual(['a', 'b', 'c']);
  });

  it('does not spread from one stored name to another unless a computed pool joins them', () => {
    const scope = {
      p1: record(true, 'P'),
      p2: record(false, 'P'),
      q1: record(false, 'Q'),
      q2: record(false, 'Q'),
    };

    expect(sorted(reelectedNames(scope, computed(scope, ['p1', 'p2'], ['q1', 'q2'])))).toEqual([
      'p1',
      'p2',
    ]);
    expect(sorted(reelectedNames(scope, computed(scope, ['p1', 'p2', 'q1'], ['q2'])))).toEqual([
      'p1',
      'p2',
      'q1',
      'q2',
    ]);
  });

  // An external that left every pool keeps its stale stored name until mark-pools clears it; the spread
  // still reaches it through that name, and from it nothing further.
  it('reaches an external in no computed pool through its stale stored name', () => {
    const scope = { a: record(true, 'P'), stale: record(false, 'P'), b: record(false) };

    expect(sorted(reelectedNames(scope, computed(scope, ['a', 'b'])))).toEqual(['a', 'b', 'stale']);
  });

  it('leaves the records untouched', () => {
    const scope = { a: record(true, 'P'), b: record(false, 'P') };

    reelectedNames(scope, computed(scope, ['a', 'b']));

    expect(scope.b.dirty).toBe(false);
  });
});
