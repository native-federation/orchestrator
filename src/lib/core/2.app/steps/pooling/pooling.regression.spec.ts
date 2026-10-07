import { portfolio } from 'lib/testing/pooling/portfolio';

/**
 * Permanent regression guards for pooling, end to end through mark → determine → pool → import map. One
 * `describe` per bug. Every init runs through the portfolio harness, which asserts the no-tear oracle
 * (`findIncoherentRemotes` + `findSplitRemotes`) on the emitted map, so each case below is also a no-tear
 * case. Islands are read off the stored `poolCause`, never off the warn text.
 */
describe('pooling regressions', () => {
  /**
   * Issue #63. Pooling used to island only the remotes the per-external resolver had marked `scope`, so a
   * monorepo family whose members were each individually compatible could still be served from two builds
   * at two versions — `@angular/core` from one remote, `@angular/router` from another — and the remote
   * consuming both ran a mismatched framework family.
   *
   * Variant election closes it by construction: a pool elects whole builds, and a remote runs the elected
   * build only when it ships every entrypoint the remote imports at versions its `requiredVersion` accepts.
   * Otherwise it runs a later round's build or its own, taking the elected files only where it agrees with
   * them on everything both ship.
   *
   * Locked here, in order: both #63 repro cases (the second with the host keeping its pin); patch drift
   * runs on the one build covering both remotes; a previous-major member leaves the shared set when its only
   * provider serves itself; a clean subset consumer of an asymmetric family is never islanded.
   */
  describe('#63: a pool resolves a coherent family', () => {
    const SCOPE = {
      'team/host': 'http://host/',
      'team/mfe-a': 'http://mfe-a/',
      'team/mfe-b': 'http://mfe-b/',
      'team/legacy': 'http://legacy/',
    };

    let p: ReturnType<typeof portfolio>;
    beforeEach(() => {
      p = portfolio(SCOPE, { hosts: ['team/host'], storage: 'nf-regression-63' });
    });

    it('islands the strict pinner rather than letting it drag one member down', async () => {
      // mfe-b pins core to ~22.0.5; mfe-a ships core + router at 22.1.0 and is the only router provider.
      // Under per-member election core resolved DOWN to mfe-b's 22.0.5 while router stayed on 22.1.0, and
      // mfe-a had to island. Electing the family: neither build serves the other remote, nobody agrees with
      // either, so the newer build wins round 1 and the pinner is the one that runs its own core.
      p.seed('@angular/core', [
        p.version('22.1.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
        p.version('22.0.5', '@angular/core', [{ remote: 'team/mfe-b', req: '~22.0.5' }]),
      ]);
      p.seed('@angular/router', [
        p.version('22.1.0', '@angular/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
      expect(importMap.imports['@angular/router']).toBe('http://mfe-a/@angular/router.js');
      expect(importMap.scopes?.[SCOPE['team/mfe-b']]).toEqual({
        '@angular/core': 'http://mfe-b/@angular/core.js',
      });

      expect(p.record('@angular/core').versions.map(v => `${v.tag}:${v.action}`)).toEqual([
        '22.1.0:share',
        '22.0.5:scope',
      ]);

      // Exactly one island: the pinner, whose range rejects the elected 22.1.0. And one warning for it.
      expect(p.islands()).toEqual({ 'team/mfe-b': 'incompatible' });
      expect(vi.mocked(p.config.log.warn).mock.calls).toHaveLength(1);
    });

    it('keeps the host tag and islands the remote that would mix builds', async () => {
      // The host ships core@22.0.5, so host precedence forces the shared core to 22.0.5. The host does not
      // ship router, so router could resolve freely to 22.1.0 from mfe-a. It is mfe-a that gives way, not
      // the host's pin: coherence costs the mixing remote a dedup, never the host its pin.
      p.seed('@angular/core', [
        p.version('22.1.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
        p.version('22.0.5', '@angular/core', [{ remote: 'team/host', req: '^22.0.0', host: true }]),
      ]);
      p.seed('@angular/router', [
        p.version('22.1.0', '@angular/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports['@angular/core']).toBe('http://host/@angular/core.js');
      expect(importMap.imports['@angular/router']).toBeUndefined();
      expect(importMap.scopes?.[SCOPE['team/mfe-a']]).toEqual({
        '@angular/core': 'http://mfe-a/@angular/core.js',
        '@angular/router': 'http://mfe-a/@angular/router.js',
      });
    });

    it('runs patch drift on the one build that covers both remotes', async () => {
      // Two remotes one patch apart, both ~21.2.0; mfe-a ships core + forms at 21.2.2, mfe-b only core at
      // 21.2.3. Per-member election put core on mfe-b's newer patch while forms stayed on mfe-a's build, so
      // mfe-a islanded (3 downloads). mfe-a's build serves both remotes, so the family runs it: older, but
      // coherent, and 2 downloads.
      p.seed('@angular/core', [
        p.version('21.2.2', '@angular/core', [{ remote: 'team/mfe-a', req: '~21.2.0' }]),
        p.version('21.2.3', '@angular/core', [{ remote: 'team/mfe-b', req: '~21.2.0' }]),
      ]);
      p.seed('@angular/forms', [
        p.version('21.2.2', '@angular/forms', [{ remote: 'team/mfe-a', req: '~21.2.0' }]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
      expect(importMap.imports['@angular/forms']).toBe('http://mfe-a/@angular/forms.js');
      expect(importMap.scopes ?? {}).toEqual({});
      expect(p.downloads(importMap)).toBe(2);
      expect(p.islands()).toEqual({});
      expect(p.config.log.warn).not.toHaveBeenCalled();
    });

    it('drops a previous-major member from the shared set when its only provider serves itself', async () => {
      // The production capture's failure. legacy pins ~21.2.0, which rejects the 22 winner, so it serves its
      // own core — but it is also the SOLE provider of animations. Self-serving takes that copy with it, so
      // animations leaves the shared set rather than staying globally shared at 21.2.18 beside core@22.0.8.
      // The mechanism is the island plus rebuild stripping the last provider, not election: nothing is ever
      // re-pointed.
      p.seed('@angular/core', [
        p.version('22.0.8', '@angular/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
        p.version('21.2.18', '@angular/core', [{ remote: 'team/legacy', req: '~21.2.0' }]),
      ]);
      p.seed('@angular/animations', [
        p.version('21.2.18', '@angular/animations', [{ remote: 'team/legacy', req: '~21.2.0' }]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
      expect(importMap.imports['@angular/animations']).toBeUndefined();
      expect(importMap.scopes?.[SCOPE['team/legacy']]).toEqual({
        '@angular/core': 'http://legacy/@angular/core.js',
        '@angular/animations': 'http://legacy/@angular/animations.js',
      });
      expect(p.islands()).toEqual({ 'team/legacy': 'incompatible' });

      // What coherence means here: one major left in the shared set, and no package split across tags.
      const shared = Object.values(p.stored()).flatMap(e =>
        e.versions.filter(v => v.action === 'share').map(v => v.tag)
      );
      expect(new Set(shared.map(tag => tag.split('.')[0]))).toEqual(new Set(['22']));
    });

    it('never islands a clean subset consumer of an asymmetric family', async () => {
      // Asymmetric coverage: mfe-a ships {core, common, material}, mfe-b only {core, common}, one patch
      // apart and newer on different members. mfe-a's build serves mfe-b too (^17.0.0 takes either patch),
      // so the whole family is mfe-a's and the map needs no scope at all: 3 downloads.
      p.seed('@angular/core', [
        p.version('17.0.1', '@angular/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
        p.version('17.0.0', '@angular/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      ]);
      p.seed('@angular/common', [
        p.version('17.0.1', '@angular/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
        p.version('17.0.0', '@angular/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      ]);
      p.seed('@angular/material', [
        p.version('17.0.1', '@angular/material', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports['@angular/core']).toBe('http://mfe-a/@angular/core.js');
      expect(importMap.imports['@angular/common']).toBe('http://mfe-a/@angular/common.js');
      expect(importMap.imports['@angular/material']).toBe('http://mfe-a/@angular/material.js');
      expect(importMap.scopes ?? {}).toEqual({});
      expect(p.downloads(importMap)).toBe(3);

      const scoped = Object.values(p.stored()).flatMap(e =>
        e.versions.filter(v => v.action === 'scope')
      );
      expect(scoped).toEqual([]);
      expect(p.islands()).toEqual({});
      expect(p.config.log.warn).not.toHaveBeenCalled();
    });
  });

  /**
   * The islanding cascade: adding one previous-major remote to a healthy portfolio used to island remotes
   * that were perfectly compatible with each other. On the production capture it took 7 remotes from 36 to
   * 64 downloads and islanded 5 of 8, three of them healthy Angular-22 remotes.
   *
   * The cause was `determine`'s extra-download objective, which counted versions rather than remote copies.
   * Two patch-drifted legacy remotes on two distinct tags therefore outvoted three modern remotes that all
   * agreed on one tag; `@angular/router`'s winner moved to the 21 line, the modern remotes'
   * `router@22.0.8` became strictly incompatible, and pooling amplified that single member's mis-election
   * into the whole family. A scoped version serves every one of its remotes from its own build, so it costs
   * one download per uncached copy; the objective counts it that way now.
   *
   * The pool also elects as one family, so members whose majorities sit on different lines no longer split
   * it (last case).
   */
  describe('islanding cascade: a previous-major minority does not island the majority', () => {
    const SCOPE = {
      'team/mfe-a': 'http://mfe-a/',
      'team/mfe-b': 'http://mfe-b/',
      'team/mfe-c': 'http://mfe-c/',
      'team/legacy-a': 'http://legacy-a/',
      'team/legacy-b': 'http://legacy-b/',
    };

    let p: ReturnType<typeof portfolio>;
    beforeEach(() => {
      p = portfolio(SCOPE, { storage: 'nf-regression-cascade' });
    });

    const winner = (member: string) =>
      p.record(member).versions.find(v => v.action === 'share')?.tag;

    // The Angular-22 majority: mfe-a and mfe-b ship core + router at 22.0.8, mfe-c only core, one patch
    // behind. `legacy` is the previous-major remote(s), honestly pinned to their own minor line.
    const seedPortfolio = (legacy: { remote: string; tag: string }[]) => {
      p.seed('@angular/core', [
        p.version('22.0.8', '@angular/core', [
          { remote: 'team/mfe-a', req: '~22.0.3' },
          { remote: 'team/mfe-b', req: '~22.0.3' },
        ]),
        p.version('22.0.6', '@angular/core', [{ remote: 'team/mfe-c', req: '~22.0.5' }]),
        ...legacy.map(l =>
          p.version(l.tag, '@angular/core', [{ remote: l.remote, req: '~21.2.0' }])
        ),
      ]);
      p.seed('@angular/router', [
        p.version('22.0.8', '@angular/router', [
          { remote: 'team/mfe-a', req: '~22.0.3' },
          { remote: 'team/mfe-b', req: '~22.0.3' },
        ]),
        ...legacy.map(l =>
          p.version(l.tag, '@angular/router', [{ remote: l.remote, req: '~21.2.0' }])
        ),
      ]);
    };

    it('shares the whole family with one previous-major remote present', async () => {
      seedPortfolio([{ remote: 'team/legacy-a', tag: '21.2.18' }]);

      const importMap = await p.runInit();

      expect(winner('@angular/core')).toBe('22.0.8');
      expect(winner('@angular/router')).toBe('22.0.8');
      expect(p.islands()).toEqual({ 'team/legacy-a': 'incompatible' });
      expect(p.downloads(importMap)).toBe(4);
    });

    it('holds when a second previous-major remote joins on its own patch tag', async () => {
      // legacy-b adds a SECOND distinct 21 tag and nothing else; it conflicts with nobody. Counting scoped
      // versions, `router@22.0.8` cost 2 against each 21 version's 1, so the winner moved to the 21 line and
      // islanded mfe-a and mfe-b across their whole family. Counting copies, both sides cost 2 and the
      // newest tag keeps it.
      seedPortfolio([
        { remote: 'team/legacy-a', tag: '21.2.18' },
        { remote: 'team/legacy-b', tag: '21.2.15' },
      ]);

      const importMap = await p.runInit();

      expect(winner('@angular/core')).toBe('22.0.8');
      expect(winner('@angular/router')).toBe('22.0.8');

      // Only the two genuinely cross-major remotes are off the elected build; none of the modern remotes
      // is. legacy-b's range accepts legacy-a's 21.2.18 build, so a later round places both in that
      // subpool. A subpool stores no `poolCause`, so the range violation behind it is not asserted here.
      expect(p.islands()).toEqual({
        'team/legacy-a': 'subpool team/legacy-a',
        'team/legacy-b': 'subpool team/legacy-a',
      });

      // mfe-c keeps deduping core; only the legacy copies run their own build.
      expect(
        p
          .record('@angular/core')
          .versions.some(v => v.action === 'scope' && v.remotes.some(r => r.name === 'team/mfe-c'))
      ).toBe(false);

      // 4 downloads with one legacy remote and still 4 with two, through the subpool. Counting versions
      // this was 6, two islands.
      expect(p.downloads(importMap)).toBe(4);
    });

    it('keeps a family whole when each member has its majority on a different line', async () => {
      // core's modern side is larger, router's legacy side is larger. Per-member election split the pool
      // here (6 downloads, mfe-a islanded on router); the pool elects as one family instead.
      p.seed('@angular/core', [
        p.version('22.0.8', '@angular/core', [
          { remote: 'team/mfe-a', req: '~22.0.3' },
          { remote: 'team/mfe-b', req: '~22.0.3' },
          { remote: 'team/mfe-c', req: '~22.0.3' },
        ]),
        p.version('21.2.18', '@angular/core', [{ remote: 'team/legacy-a', req: '~21.2.0' }]),
      ]);
      p.seed('@angular/router', [
        p.version('22.0.8', '@angular/router', [{ remote: 'team/mfe-a', req: '~22.0.3' }]),
        p.version('21.2.18', '@angular/router', [
          { remote: 'team/legacy-a', req: '~21.2.0' },
          { remote: 'team/legacy-b', req: '~21.2.0' },
        ]),
      ]);

      const importMap = await p.runInit();

      // mfe-a's build serves three remotes against legacy-a's two, so the whole family is 22; the legacy
      // pair runs legacy-a's 21 build together.
      expect(winner('@angular/core')).toBe('22.0.8');
      expect(winner('@angular/router')).toBe('22.0.8');
      expect(p.islands()).toEqual({
        'team/legacy-a': 'subpool team/legacy-a',
        'team/legacy-b': 'subpool team/legacy-a',
      });
      expect(p.downloads(importMap)).toBe(4);
    });
  });

  /**
   * A verdict belongs to the copy that objected, not to the whole `SharedVersion`. `requiredVersion` and
   * `strictVersion` are per-build settings, so one row can hold copies that disagree; before the fix a
   * single strict objector marked the row `scope`, every co-tagged copy was scoped with it, and pooling then
   * islanded those remotes across the whole family.
   *
   * Compatibility is still asked of the row as a whole — one version is one file served from one basis, so
   * redirecting it has to satisfy everyone it would redirect. Only the write-back is per copy (see
   * docs/version-resolver.md §"A verdict belongs to the copy, not the version").
   *
   * Both fixtures were measured in the browser before the fix at 5 and 4 emitted URLs. The second one only
   * reproduces warm — cold, the objector's own tag wins the election and nothing is dragged — so its
   * committed copies are seeded `cached`.
   */
  describe('per-copy verdicts: a co-tagged copy is not scoped with its objecting neighbour', () => {
    const SCOPE = {
      'team/mfe-a': 'http://mfe-a/',
      'team/mfe-b': 'http://mfe-b/',
      'team/mfe-c': 'http://mfe-c/',
      'team/mfe-d': 'http://mfe-d/',
      'team/mfe-x': 'http://mfe-x/',
      'team/mfe1': 'http://mfe1/',
      'team/mfe2': 'http://mfe2/',
      'team/mfe3': 'http://mfe3/',
    };

    let p: ReturnType<typeof portfolio>;
    beforeEach(() => {
      p = portfolio(SCOPE, { storage: 'nf-regression-per-copy' });
    });

    const rows = (external: string) =>
      p
        .record(external)
        .versions.map(v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name).join(',')}]`);

    it('keeps a compatible co-tagged remote deduping when its neighbour objects', async () => {
      // mfe-a and mfe-c both ship core@21.1.1; only mfe-c's `~21.1.1` rejects the 21.2.0 majority.
      // mfe-a's `^21.1.0` accepts it and could dedup.
      p.seed('@angular/core', [
        p.version('21.1.1', '@angular/core', [
          { remote: 'team/mfe-a', req: '^21.1.0' },
          { remote: 'team/mfe-c', req: '~21.1.1' },
        ]),
        p.version('21.2.0', '@angular/core', [
          { remote: 'team/mfe-b', req: '^21.2.0' },
          { remote: 'team/mfe-d', req: '^21.2.0' },
          { remote: 'team/mfe-x', req: '^21.2.0' },
        ]),
      ]);
      p.seed('@angular/common', [
        p.version('21.1.1', '@angular/common', [{ remote: 'team/mfe-a', req: '^21.1.0' }]),
        p.version('21.2.0', '@angular/common', [
          { remote: 'team/mfe-b', req: '^21.2.0' },
          { remote: 'team/mfe-d', req: '^21.2.0' },
          { remote: 'team/mfe-x', req: '^21.2.0' },
        ]),
      ]);

      const importMap = await p.runInit();

      // The verdict follows the copy: mfe-a keeps its own tag in a `skip` row of its own, mfe-c alone
      // scopes. Both rows stay at 21.1.1 and stay adjacent, so the record is still newest-first.
      expect(rows('@angular/core')).toEqual([
        '21.2.0:share:[team/mfe-b,team/mfe-d,team/mfe-x]',
        '21.1.1:skip:[team/mfe-a]',
        '21.1.1:scope:[team/mfe-c]',
      ]);

      // Nothing islands mfe-a, so its `common` dedup survives.
      expect(rows('@angular/common')).toEqual([
        '21.2.0:share:[team/mfe-b,team/mfe-d,team/mfe-x]',
        '21.1.1:skip:[team/mfe-a]',
      ]);

      // The majority is shared from one build, and mfe-c honours its own pin.
      expect(importMap.imports).toEqual({
        '@angular/core': 'http://mfe-b/@angular/core.js',
        '@angular/common': 'http://mfe-b/@angular/common.js',
      });
      expect(importMap.scopes?.[SCOPE['team/mfe-c']]).toEqual({
        '@angular/core': 'http://mfe-c/@angular/core.js',
      });

      // mfe-a resolves both members through `imports`, i.e. from mfe-b's build — 3 files, the reachable
      // minimum, down from the 5 measured in the browser.
      expect(importMap.scopes?.[SCOPE['team/mfe-a']]).toBeUndefined();
      expect(p.downloads(importMap)).toBe(3);

      // Only the objector serves itself. mfe-a's `^21.1.0` accepts 21.2.0, so there was never an
      // incompatibility to record for it.
      expect(p.islands()).toEqual({ 'team/mfe-c': 'incompatible' });
    });

    it("shares the pinner's tag with a co-tagged joiner that accepts the winner", async () => {
      // mfe1 and mfe2 are already committed, so 22.1.0 wins on cost and mfe3 joins into mfe2's row. mfe3
      // ships only `core`, so its "whole family" is one member: this instance tells the per-copy write-back
      // apart from a fix that only stopped pooling islanding mfe3, which would silence the island but keep
      // the download.
      p.seed('@angular/core', [
        p.version('22.1.0', '@angular/core', [
          { remote: 'team/mfe1', req: '^22.0.0', cached: true },
        ]),
        p.version('22.0.5', '@angular/core', [
          { remote: 'team/mfe2', req: '~22.0.5', cached: true },
          { remote: 'team/mfe3', req: '^22.0.0' },
        ]),
      ]);
      p.seed('@angular/router', [
        p.version('22.1.0', '@angular/router', [
          { remote: 'team/mfe1', req: '^22.0.0', cached: true },
        ]),
      ]);

      const importMap = await p.runInit();

      // Only the pinner scopes; mfe3 leaves its row and dedups.
      expect(rows('@angular/core')).toEqual([
        '22.1.0:share:[team/mfe1]',
        '22.0.5:skip:[team/mfe3]',
        '22.0.5:scope:[team/mfe2]',
      ]);

      // mfe2's pin is honoured from its own build.
      expect(importMap.scopes?.[SCOPE['team/mfe2']]).toEqual({
        '@angular/core': 'http://mfe2/@angular/core.js',
      });

      // mfe3's copy used to sit inside a `scope` row, so it kept downloading its own build even once
      // pooling stopped islanding it. 3 files, matching a cold resolution of the same three remotes.
      expect(importMap.scopes?.[SCOPE['team/mfe3']]).toBeUndefined();
      expect(p.downloads(importMap)).toBe(3);

      // The pinner is the only remote off the elected build; mfe3 is not.
      expect(p.islands()).toEqual({ 'team/mfe2': 'incompatible' });
    });
  });
});
