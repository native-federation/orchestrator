import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { byTag, findVersionForTag, mergeRows, rowAt } from './rows';
import type { SharedVersion, SharedVersionAction } from './version.contract';

const row = (tag: string, action: SharedVersionAction, ...remotes: string[]): SharedVersion => ({
  tag,
  host: false,
  action,
  remotes: remotes.map(name => mockVersionRemote(name)),
});

// `tag:action:[remotes]`, the way the pooling specs read a record.
const shape = (versions: SharedVersion[]) =>
  versions.map(v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name)}]`);

describe('rows', () => {
  describe('byTag', () => {
    const newest = byTag(createVersionCheck().compare);

    it('puts the newest tag first by semver, not by string', () => {
      const versions = [row('2.9.0', 'skip', 'a'), row('2.10.0', 'share', 'b')];

      expect(shape(versions.sort(newest))).toEqual(['2.10.0:share:[b]', '2.9.0:skip:[a]']);
    });

    // Within-tag order is observable (round 1's record-order ties, determine's `versions[0]`): the dynamic
    // verdict write relies on this to keep a record's rows where they were.
    it("leaves one tag's rows in the order they came", () => {
      const versions = [
        row('1.0.0', 'share', 'old'),
        row('2.0.0', 'scope', 'a'),
        row('2.0.0', 'share', 'b'),
      ];

      expect(shape(versions.sort(newest))).toEqual([
        '2.0.0:scope:[a]',
        '2.0.0:share:[b]',
        '1.0.0:share:[old]',
      ]);
    });
  });

  describe('rowAt', () => {
    it('finds the row of exactly that tag and action', () => {
      const skip = row('2.0.0', 'skip', 'b');
      const versions = [row('2.0.0', 'share', 'a'), skip, row('1.0.0', 'scope', 'c')];

      expect(rowAt(versions, '2.0.0', 'skip')).toBe(skip);
      expect(rowAt(versions, '2.0.0', 'scope')).toBeUndefined();
    });
  });

  describe('mergeRows', () => {
    it('keeps one row per tag and action, the first absorbing the copies of the later ones', () => {
      const first = row('2.0.0', 'skip', 'a');
      const versions = [first, row('2.0.0', 'share', 'b'), row('2.0.0', 'skip', 'c')];

      const merged = mergeRows(versions);

      expect(shape(merged)).toEqual(['2.0.0:skip:[a,c]', '2.0.0:share:[b]']);
      // In place: callers merging rows they built or own mutate them anyway.
      expect(merged[0]).toBe(first);
    });

    it('lets the lead absorb its pair wherever it stands, its copies in front', () => {
      const lead = row('2.0.0', 'skip', 'w');
      const versions = [row('2.0.0', 'skip', 'a'), row('1.0.0', 'skip', 'b'), lead];

      const merged = mergeRows(versions, lead);

      expect(shape(merged)).toEqual(['1.0.0:skip:[b]', '2.0.0:skip:[w,a]']);
      expect(merged[1]).toBe(lead);
    });
  });

  describe('findVersionForTag', () => {
    it('prefers the shareable row at the tag over a scope row before it', () => {
      const shareable = row('2.0.0', 'skip', 'b');

      expect(findVersionForTag([row('2.0.0', 'scope', 'a'), shareable], '2.0.0')).toBe(shareable);
    });

    it('falls back to the scope row, and finds nothing at another tag', () => {
      const scoped = row('2.0.0', 'scope', 'a');

      expect(findVersionForTag([scoped], '2.0.0')).toBe(scoped);
      expect(findVersionForTag([scoped], '1.0.0')).toBeUndefined();
    });
  });
});
