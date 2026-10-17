import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { createAcceptsTag } from './compatibility';
import fc from 'fast-check';
import { byTag, findVersionForTag, mergeRows, redirectRow, rowAt, scopeRemotes } from './rows';
import type { SharedVersion, SharedVersionAction, SharedVersionMeta } from './version.contract';

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

  describe('redirectRow', () => {
    const { isCompatible, compare } = createVersionCheck();
    const acceptsTag = createAcceptsTag(isCompatible, compare);
    // Every copy of these rows sits at 2.1.0; only its range and strictness differ.
    const copy = (name: string, requiredVersion: string, strictVersion = true) =>
      mockVersionRemote(name, 'dep', { requiredVersion, strictVersion });
    const at = (...remotes: SharedVersionMeta[]): SharedVersion => ({
      tag: '2.1.0',
      host: false,
      action: 'share',
      remotes,
    });

    it('skips a row whose copies all accept the tag', () => {
      const version = at(copy('a', '^2.0.0'), copy('b', '~2.2.0', false));

      const rows = redirectRow(version, '2.2.0', acceptsTag);

      expect(shape(rows)).toEqual(['2.1.0:skip:[a,b]']);
      expect(rows[0]).toBe(version);
    });

    it('skips a row whose rejecting copies are all non-strict: they take what is shared', () => {
      const version = at(copy('a', '~2.1.0', false), copy('b', '~2.1.0', false));

      expect(shape(redirectRow(version, '3.0.0', acceptsTag))).toEqual(['2.1.0:skip:[a,b]']);
    });

    it('scopes a row whose copies all reject the tag strictly', () => {
      const version = at(copy('a', '~2.1.0'), copy('b', '^2.0.0'));

      const rows = redirectRow(version, '3.0.0', acceptsTag);

      expect(shape(rows)).toEqual(['2.1.0:scope:[a,b]']);
      expect(rows[0]).toBe(version);
    });

    it('splits the strict objectors into a scope row beside the skipped rest', () => {
      const version = at(copy('a', '~2.1.0'), copy('b', '^2.0.0'), copy('c', '~2.1.0', false));

      const rows = redirectRow(version, '2.2.0', acceptsTag);

      // a rejects 2.2.0 strictly; b accepts it; c rejects it but is not strict.
      expect(shape(rows)).toEqual(['2.1.0:skip:[b,c]', '2.1.0:scope:[a]']);
      expect(rows[0]).toBe(version);
    });
  });

  describe('scopeRemotes', () => {
    it("moves the remote's copy into a scope row of its tag, right after its source row", () => {
      const versions = [row('2.0.0', 'share', 'a', 'r'), row('1.0.0', 'skip', 'b')];

      expect(shape(scopeRemotes(versions, ['r']))).toEqual([
        '2.0.0:share:[a]',
        '2.0.0:scope:[r]',
        '1.0.0:skip:[b]',
      ]);
    });

    // The emptied row goes, so a newer copy's scope row keeps its place above an older winner and the record
    // stays newest-first.
    it('drops the row it empties, the scope row taking its place', () => {
      const versions = [row('2.2.0', 'skip', 'r'), row('2.1.0', 'share', 'a')];

      expect(shape(scopeRemotes(versions, ['r']))).toEqual(['2.2.0:scope:[r]', '2.1.0:share:[a]']);
    });

    it('joins a scope row already at the tag, and leaves scope rows and other remotes alone', () => {
      const versions = [
        row('2.0.0', 'scope', 'c'),
        row('2.0.0', 'skip', 'r', 'b'),
        row('1.0.0', 'scope', 'r'),
      ];

      expect(shape(scopeRemotes(versions, ['r']))).toEqual([
        '2.0.0:scope:[c,r]',
        '2.0.0:skip:[b]',
        '1.0.0:scope:[r]',
      ]);
    });

    // determine finds the host's tag by the flag; a flag left on the source would hand the host's precedence
    // to whichever copy now leads it.
    it("carries the host's flag to the scope row, its copy in front", () => {
      const source: SharedVersion = { ...row('2.0.0', 'share', 'host', 'a'), host: true };
      const versions = [row('2.0.0', 'scope', 'c'), source];

      const rows = scopeRemotes(versions, ['host']);

      expect(shape(rows)).toEqual(['2.0.0:scope:[host,c]', '2.0.0:share:[a]']);
      expect(rows.map(v => v.host)).toEqual([true, false]);
    });

    it("leaves a host row's flag when another remote leaves it", () => {
      const versions = [{ ...row('2.0.0', 'share', 'host', 'r'), host: true }];

      const rows = scopeRemotes(versions, ['r']);

      expect(rows.map(v => [v.action, v.host])).toEqual([
        ['share', true],
        ['scope', false],
      ]);
    });

    it('moves copies by remote, then by row, the host in front', () => {
      const versions = [
        row('2.0.0', 'scope', 'c'),
        { ...row('2.0.0', 'share', 'host', 'a', 'b'), host: true },
        row('2.0.0', 'skip', 'a'),
      ];

      const rows = scopeRemotes(versions, ['b', 'a', 'host']);

      expect(shape(rows)).toEqual(['2.0.0:scope:[host,c,b,a,a]']);
      expect(rows.map(v => v.host)).toEqual([true]);
    });

    // The batch replaced one scopeRemote call per remote; deciding persists its rows, so it must match that fold
    // exactly. `scopeRemote` below is the removed function, verbatim.
    it('matches moving each remote in turn', () => {
      function scopeRemote(versions: SharedVersion[], remote: string): SharedVersion[] {
        const rows = [...versions];
        for (const source of versions) {
          if (source.action === 'scope') continue;
          const copies = source.remotes.filter(r => r.name === remote);
          if (copies.length === 0) continue;
          const host = source.host && copies.includes(source.remotes[0]!);
          source.remotes = source.remotes.filter(r => r.name !== remote);
          if (host) source.host = false;
          let scoped = rowAt(rows, source.tag, 'scope');
          if (!scoped) {
            scoped = { tag: source.tag, host: false, action: 'scope', remotes: [] };
            rows.splice(rows.indexOf(source) + 1, 0, scoped);
          }
          if (host) {
            scoped.host = true;
            scoped.remotes.unshift(...copies);
          } else scoped.remotes.push(...copies);
        }
        return rows.filter(v => v.remotes.length > 0);
      }

      const names = ['a', 'b', 'c', 'd', 'host'];
      const rowArb = fc.record({
        tag: fc.constantFrom('3.0.0', '2.0.0', '1.0.0'),
        action: fc.constantFrom<SharedVersionAction>('share', 'skip', 'scope'),
        host: fc.boolean(),
        remotes: fc.array(fc.constantFrom(...names), { minLength: 1, maxLength: 5 }),
      });
      // Copies are compared by identity, as deciding does, so both runs share one set of copies.
      const build = (
        spec: { tag: string; action: SharedVersionAction; host: boolean; remotes: string[] }[]
      ) => {
        const copies = spec.map(r => r.remotes.map(name => mockVersionRemote(name)));
        return () =>
          spec.map((r, i) => ({
            tag: r.tag,
            action: r.action,
            host: r.host,
            remotes: [...copies[i]!],
          }));
      };

      fc.assert(
        fc.property(
          fc.array(rowArb, { maxLength: 6 }),
          fc.shuffledSubarray(names),
          (spec, remotes) => {
            const rows = build(spec);
            const folded = remotes.reduce(scopeRemote, rows());
            expect(scopeRemotes(rows(), remotes)).toEqual(folded);
            const batch = scopeRemotes(rows(), remotes);
            batch.forEach((v, i) =>
              v.remotes.forEach((r, j) => expect(r).toBe(folded[i]!.remotes[j]))
            );
          }
        ),
        { numRuns: 2000 }
      );
    });
  });
});
