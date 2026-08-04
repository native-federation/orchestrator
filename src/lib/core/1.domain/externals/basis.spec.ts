import {
  addRemoteToVersion,
  countUncoveredEntrypoints,
  isBetterBasis,
  uncoveredEntrypoints,
  versionDemands,
  versionEntries,
} from './basis';
import type { SharedVersion, SharedVersionMeta } from './version.contract';

const remote = (
  name: string,
  entries: string[],
  cached = false,
  demand: Partial<Pick<SharedVersionMeta, 'requiredVersion' | 'strictVersion'>> = {}
): SharedVersionMeta => ({
  name,
  requiredVersion: demand.requiredVersion ?? '~2.1.0',
  strictVersion: demand.strictVersion ?? true,
  cached,
  entries: Object.fromEntries(entries.map(e => [e, `${e.replace(/\//g, '-')}.js`])),
});

const version = (remotes: SharedVersionMeta[], host = false): SharedVersion => ({
  tag: '2.1.0',
  host,
  action: 'share',
  remotes,
});

describe('basis', () => {
  describe('isBetterBasis', () => {
    it('should prefer the copy with the most entrypoints', () => {
      expect(isBetterBasis(remote('b', ['dep-a', 'dep-a/sub']), remote('a', ['dep-a']))).toBe(true);
      expect(isBetterBasis(remote('b', ['dep-a']), remote('a', ['dep-a', 'dep-a/sub']))).toBe(
        false
      );
    });

    it('should keep the incumbent on an equal entrypoint count', () => {
      expect(isBetterBasis(remote('b', ['dep-a']), remote('a', ['dep-a']))).toBe(false);
    });

    it('should prefer a cached copy over a wider uncached one', () => {
      const cached = remote('a', ['dep-a'], true);
      expect(isBetterBasis(remote('b', ['dep-a', 'dep-a/sub']), cached)).toBe(false);
      expect(isBetterBasis(cached, remote('b', ['dep-a', 'dep-a/sub']))).toBe(true);
    });
  });

  describe('addRemoteToVersion', () => {
    it('should promote a wider remote to the basis', () => {
      const v = version([remote('a', ['dep-a'])]);

      addRemoteToVersion(v, remote('b', ['dep-a', 'dep-a/sub']));

      expect(v.remotes.map(r => r.name)).toEqual(['b', 'a']);
    });

    it('should append a remote that does not improve coverage', () => {
      const v = version([remote('a', ['dep-a', 'dep-a/sub'])]);

      addRemoteToVersion(v, remote('b', ['dep-a']));

      expect(v.remotes.map(r => r.name)).toEqual(['a', 'b']);
    });

    it('should never displace a cached basis', () => {
      const v = version([remote('a', ['dep-a'], true)]);

      addRemoteToVersion(v, remote('b', ['dep-a', 'dep-a/sub']));

      expect(v.remotes.map(r => r.name)).toEqual(['a', 'b']);
    });

    it('should never displace a host basis', () => {
      const v = version([remote('a', ['dep-a'])], true);

      addRemoteToVersion(v, remote('b', ['dep-a', 'dep-a/sub']));

      expect(v.remotes.map(r => r.name)).toEqual(['a', 'b']);
    });

    it('should promote a host remote unconditionally and flag the version', () => {
      const v = version([remote('a', ['dep-a', 'dep-a/sub'])]);

      addRemoteToVersion(v, remote('host', ['dep-a']), true);

      expect(v.remotes.map(r => r.name)).toEqual(['host', 'a']);
      expect(v.host).toBe(true);
    });

    it('should keep arrival order stable across repeated equal inserts', () => {
      const v = version([remote('a', ['dep-a'])]);

      addRemoteToVersion(v, remote('b', ['dep-a']));
      addRemoteToVersion(v, remote('c', ['dep-a']));

      expect(v.remotes.map(r => r.name)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('versionDemands', () => {
    it('should return the single remote as-is', () => {
      const only = remote('a', ['dep-a']);

      expect(versionDemands(version([only]))).toEqual([only]);
    });

    it('should surface a demand no matter which remote holds the basis slot', () => {
      const strict = remote('strict', ['dep-a'], false, { strictVersion: true });
      const loose = remote('loose', ['dep-a', 'dep-a/sub'], false, { strictVersion: false });

      expect(versionDemands(version([loose, strict]))).toEqual([loose, strict]);
      expect(versionDemands(version([strict, loose]))).toEqual([strict, loose]);
    });

    it('should collapse remotes that demand the same thing', () => {
      const v = version([remote('a', ['dep-a']), remote('b', ['dep-a']), remote('c', ['dep-a'])]);

      expect(versionDemands(v).map(d => d.name)).toEqual(['a']);
    });

    it('should keep remotes that differ on any negotiated field', () => {
      const v = version([
        remote('range', ['dep-a'], false, { requiredVersion: '~2.1.0' }),
        remote('wider-range', ['dep-a'], false, { requiredVersion: '^2.0.0' }),
        remote('loose', ['dep-a'], false, { strictVersion: false }),
        remote('downloaded', ['dep-a'], true),
      ]);

      expect(versionDemands(v).map(d => d.name)).toEqual([
        'range',
        'wider-range',
        'loose',
        'downloaded',
      ]);
    });
  });

  describe('versionEntries', () => {
    it('should merge the entrypoints of every copy', () => {
      const v = version([remote('a', ['dep-a']), remote('b', ['dep-a', 'dep-a/sub'])]);

      expect(Array.from(versionEntries(v), ([entry, r]) => [entry, r.name])).toEqual([
        ['dep-a', 'a'],
        ['dep-a/sub', 'b'],
      ]);
    });

    it('should let the earliest copy claim a shared entrypoint', () => {
      const v = version([remote('basis', ['dep-a']), remote('other', ['dep-a'])]);

      expect(versionEntries(v).get('dep-a')!.name).toBe('basis');
    });

    // Pooling anchored `anchored` on a foreign build, so the import map names that build's files in its
    // scope. Counting `dep-a/sub` here would promise a specifier no other consumer can resolve: the
    // global mapping never gets it, and every user of this basis would go looking.
    it('should skip a copy pooling anchored on a foreign build', () => {
      const anchored = { ...remote('anchored', ['dep-a', 'dep-a/sub']), servedBy: 'elsewhere' };
      const v = version([remote('basis', ['dep-a']), anchored]);

      expect(Array.from(versionEntries(v).keys())).toEqual(['dep-a']);
    });

    it('should fall through to the next copy for an entrypoint an anchored one claimed first', () => {
      const anchored = { ...remote('anchored', ['dep-a']), servedBy: 'elsewhere' };
      const v = version([anchored, remote('serving', ['dep-a'])]);

      expect(versionEntries(v).get('dep-a')!.name).toBe('serving');
    });
  });

  describe('uncoveredEntrypoints', () => {
    it('should list only the entrypoints the version cannot serve', () => {
      const covered = versionEntries(version([remote('a', ['dep-a'])]));

      expect(uncoveredEntrypoints(remote('b', ['dep-a', 'dep-a/sub']), covered)).toEqual([
        'dep-a/sub',
      ]);
      expect(uncoveredEntrypoints(remote('b', ['dep-a']), covered)).toEqual([]);
    });

    it('should treat a sibling entrypoint as covered once it joins the version', () => {
      const v = version([remote('a', ['dep-a'])]);
      const sibling = remote('b', ['dep-a', 'dep-a/sub']);

      addRemoteToVersion(v, sibling);

      expect(uncoveredEntrypoints(sibling, versionEntries(v))).toEqual([]);
    });
  });

  describe('countUncoveredEntrypoints', () => {
    it('should match the name-materializing variant', () => {
      const covered = versionEntries(version([remote('a', ['dep-a'])]));

      expect(countUncoveredEntrypoints(remote('b', ['dep-a', 'dep-a/sub', 'dep-a/x']), covered)).toBe(
        2
      );
      expect(countUncoveredEntrypoints(remote('b', ['dep-a']), covered)).toBe(0);
    });
  });
});
