import type { DenseSharedInfo, ImportMap, RemoteEntry, SharedVersion } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';

/**
 * Permanent regression guards for pooling, end to end through pool → determine → import map. One
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
   * This closes it by construction: a pool elects whole builds, and a remote runs the elected
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

  /**
   * Found by the no-tear property (pooling.property.init.spec.ts). Round 1's winner lacked a package, and the
   * extension published it from another build that agrees with the winner; every remote the extended global
   * tags then served moved onto the global map. One shipping both packages at an older tag resolved the
   * winner's `m0@18.0.1` beside the other build's `m1@18.0.1`: a pair no build shipped.
   *
   * The extension may still publish the package, but a remote moves onto it only when one build witnesses
   * the combination it would resolve; otherwise it serves itself, `uncovered`.
   *
   * Shrunk from the property suite (POOLING_PROPERTY_SEED=1..3, SCALE=5); every range is the caret of its own
   * tag unless a case says otherwise, and `@lib/*` shares one npm-scope label.
   */
  describe('extension witness: the extended global tags take a remote only when one build shipped it', () => {
    const SCOPE = {
      'team/r0': 'http://r0/',
      'team/r1': 'http://r1/',
      'team/r2': 'http://r2/',
      'team/r3': 'http://r3/',
    } as const;
    const M0 = '@lib/m0';
    const M1 = '@lib/m1';

    let p: ReturnType<typeof portfolio>;
    beforeEach(() => {
      p = portfolio(SCOPE, { storage: 'nf-regression-extension-witness' });
    });

    const version = (
      tag: string,
      external: string,
      remotes: string[],
      o: { host?: boolean; req?: Record<string, string> } = {}
    ): SharedVersion => ({
      ...p.version(
        tag,
        external,
        remotes.map(remote => ({ remote, req: o.req?.[remote] ?? `^${tag}`, strict: false }))
      ),
      host: o.host ?? false,
    });

    const copyOf = (external: string, remote: string) =>
      p
        .record(external)
        .versions.flatMap(v =>
          v.remotes
            .filter(r => r.name === remote)
            .map(r => ({ ...r, action: v.action, tag: v.tag }))
        )[0]!;

    const ownFiles = (remote: keyof typeof SCOPE) => ({
      [M0]: `${SCOPE[remote]}@lib/m0.js`,
      [M1]: `${SCOPE[remote]}@lib/m1.js`,
    });

    it('keeps a remote off a pair two agreeing builds publish but none shipped together', async () => {
      // r1 and r2's `^18.0.1` reject r0's 18.0.0, so r0's build serves only itself and no subpool forms; r1
      // wins round 1 with m0@18.0.1 (r2 agrees with it), and the extension publishes m1@18.0.1 from r2.
      p.seed(M0, [version('18.0.0', M0, ['team/r0']), version('18.0.1', M0, ['team/r1'])]);
      p.seed(M1, [version('18.0.0', M1, ['team/r0']), version('18.0.1', M1, ['team/r2'])]);

      // The harness asserts no-tear on this map: r0 used to resolve {m0@18.0.1, m1@18.0.1}, a
      // combination r1 (m0 only) and r2 (m1 only) each ship half of.
      const importMap = await p.runInit();

      expect(importMap.imports).toEqual({
        [M0]: 'http://r1/@lib/m0.js',
        [M1]: 'http://r2/@lib/m1.js',
      });
      // r0 accepts every tag the map publishes, so it serves its own family as `uncovered`.
      expect(importMap.scopes?.[SCOPE['team/r0']]).toEqual(ownFiles('team/r0'));
      for (const name of [M0, M1])
        expect(copyOf(name, 'team/r0')).toMatchObject({ action: 'scope', poolCause: 'uncovered' });
      expect(p.islands()).toEqual({ 'team/r0': 'uncovered' });
    });

    // The positive control: an over-strict gate would still pass the case above. r1 is the host so it wins
    // round 1 although r3 serves everyone; otherwise r3 wins outright and the extension never runs. r3 runs a
    // subpool over r0 and r2 until the extension publishes m1@18.0.1, after which r3's own build witnesses
    // r0's pair: every remote moves onto the global map.
    it('moves a remote onto the global map when one build shipped its combination', async () => {
      p.seed(M0, [
        version('18.0.0', M0, ['team/r0'], { req: { 'team/r0': '^18.0.0' } }),
        version('18.0.1', M0, ['team/r1', 'team/r3'], { host: true }),
      ]);
      p.seed(M1, [
        version('18.0.0', M1, ['team/r0'], { req: { 'team/r0': '^18.0.0' } }),
        version('18.0.1', M1, ['team/r2', 'team/r3']),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports).toEqual({
        [M0]: 'http://r1/@lib/m0.js',
        [M1]: 'http://r2/@lib/m1.js',
      });
      expect(importMap.scopes ?? {}).toEqual({});
      for (const name of [M0, M1]) expect(copyOf(name, 'team/r0').poolCause).toBeUndefined();
      expect(p.islands()).toEqual({});
    });
  });

  /**
   * Found by the property suite: a warm re-election must keep a tied round-1 winner. The tie rule
   * prefers the previous winner, which used to be inferred from the basis of the stored `share` rows. Rows
   * the winner's peers took over by rule 5 have a lender as their basis, so a lender with more such rows than
   * the winner has own rows was read as the previous winner and the election flipped. The winner is now
   * stored as `poolWinner`.
   *
   * r0 ships m0 and m4; r1 ships m1..m4; all at 18.1.1. Neither build serves the other, both agree, so the
   * election ties and record order elects r0.
   */
  describe('re-election keeps a tied winner', () => {
    let p: ReturnType<typeof portfolio>;
    beforeEach(() => {
      p = portfolio({ r0: 'http://r0/', r1: 'http://r1/' }, { storage: 'nf-regression-tie' });
    });

    const seed = (name: string, remotes: string[]) =>
      p.seed(name, [
        p.version(
          '18.1.1',
          name,
          remotes.map(remote => ({ remote, req: '^18.1.1' }))
        ),
      ]);

    const seedTiedPool = () => {
      seed('@fam/m0', ['r0']);
      seed('@fam/m1', ['r1']);
      seed('@fam/m2', ['r1']);
      seed('@fam/m3', ['r1']);
      seed('@fam/m4', ['r0', 'r1']);
    };

    it('elects the same winner when every member is marked dirty again', async () => {
      seedTiedPool();
      const coldMap = await p.runInit();
      const coldRecord = structuredClone(p.stored());
      expect(coldMap.imports['@fam/m4']).toBe('http://r0/@fam/m4.js');

      for (const [name, external] of Object.entries(p.stored()))
        p.adapters.sharedExternalsRepo.addOrUpdate(name, { ...external, dirty: true }, undefined);
      const warmMap = await p.runInit();

      expect(p.stored()).toEqual(coldRecord);
      expect(warmMap).toEqual(coldMap);
    });

    it('keeps the winner when a newly labelled member joins the tied pool', async () => {
      seedTiedPool();
      const coldMap = await p.runInit();
      const coldM4 = structuredClone(p.record('@fam/m4'));

      // r1 starts shipping '@fam/a'. Members are ordered by name, so r1 now comes first in record order: the
      // tie still holds, and only the stored winner keeps it from flipping to r1. The joiner has no
      // `poolWinner` yet.
      seed('@fam/a', ['r1']);
      const warmMap = await p.runInit();

      expect(p.record('@fam/m4')).toEqual(coldM4);
      expect(warmMap.imports['@fam/m4']).toBe(coldMap.imports['@fam/m4']);
      expect(Object.values(p.stored()).map(e => e.poolWinner)).toEqual(Array(6).fill('r0'));
    });
  });

  /**
   * Found by the property suite: two equal builds tying for a subpool were told apart by record order,
   * so a permuted manifest renamed the subpool, and a re-election, which reads that order from the record pooling
   * rewrote, could pick the other build and move a remote off the global map. A subpool tie now goes by name.
   *
   * The host ships the family at 18.0.0, which neither `^17` remote accepts. team/b and team/a ship one 17.0.0
   * build, so each one's build serves both; team/b comes first in record order and still runs team/a's
   * build.
   */
  describe('equal subpool builds are told apart by name, whatever the registration order', () => {
    const SCOPE = { 'team/host': 'http://host/', 'team/a': 'http://a/', 'team/b': 'http://b/' };
    const MEMBERS = ['@fam/m0', '@fam/m1'];

    let p: ReturnType<typeof portfolio>;
    beforeEach(() => {
      p = portfolio(SCOPE, { hosts: ['team/host'], storage: 'nf-regression-d10' });
      for (const name of MEMBERS)
        p.seed(name, [
          p.version('18.0.0', name, [{ remote: 'team/host', req: '^18.0.0', host: true }]),
          p.version('17.0.0', name, [
            { remote: 'team/b', req: '^17.0.0' },
            { remote: 'team/a', req: '^17.0.0' },
          ]),
        ]);
    });

    const servedBy = () =>
      Object.fromEntries(
        MEMBERS.flatMap(name =>
          p
            .record(name)
            .versions.flatMap(v => v.remotes)
            .filter(r => r.name !== 'team/host')
            .map(r => [`${name}|${r.name}`, r.servedBy])
        )
      );

    it('runs the subpool on the build whose remote sorts first, on init and on re-election', async () => {
      const coldMap = await p.runInit();
      const coldRecord = structuredClone(p.stored());

      expect(servedBy()).toEqual({
        '@fam/m0|team/a': 'team/a',
        '@fam/m0|team/b': 'team/a',
        '@fam/m1|team/a': 'team/a',
        '@fam/m1|team/b': 'team/a',
      });
      expect(coldMap.scopes?.[SCOPE['team/b']]?.['@fam/m0']).toBe('http://a/@fam/m0.js');

      for (const [name, external] of Object.entries(p.stored()))
        p.adapters.sharedExternalsRepo.addOrUpdate(name, { ...external, dirty: true }, undefined);
      const warmMap = await p.runInit();

      expect(p.stored()).toEqual(coldRecord);
      expect(warmMap).toEqual(coldMap);
    });
  });

  /**
   * Dynamic init. `update-cache` filed a runtime-loaded copy into whatever row `findVersionForTag`
   * returned for its tag, which falls back to a `scope` row, and joined a `skip` row even when nothing shared
   * the external. Both left the record disagreeing with the map the page was handed.
   *
   * Every page below is a real one: the init and the load register remote entries, `reload` opens the next
   * page over what the last committed, and the warm init skips every remote it has cached, as
   * get-remote-entries does, so it runs pool → determine → import map over the record the load left.
   */
  const shared = (
    packageName: string,
    version: string,
    requiredVersion: string,
    strictVersion = true
  ): DenseSharedInfo =>
    ({
      packageName,
      version,
      requiredVersion,
      singleton: true,
      strictVersion,
      pool: 'fw',
      entries: { [packageName]: `${packageName.slice(1).replace('/', '_')}.js` },
    }) as DenseSharedInfo;

  const entry = (name: string, ...sharedInfo: DenseSharedInfo[]): RemoteEntry =>
    ({
      name,
      url: `http://${name.split('/')[1]}/remoteEntry.json`,
      exposes: [],
      shared: sharedInfo,
    }) as unknown as RemoteEntry;

  const file = (remote: string, packageName: string) =>
    `http://${remote.split('/')[1]}/${packageName.slice(1).replace('/', '_')}.js`;

  // What a remote resolves a specifier to: its own scope first, then `imports`, as the browser does.
  const resolves = (importMap: ImportMap, remote: string, specifier: string) =>
    importMap.scopes?.[`http://${remote.split('/')[1]}/`]?.[specifier] ??
    importMap.imports[specifier];

  const rows = (p: ReturnType<typeof portfolio>, external: string) =>
    p
      .record(external)
      .versions.map(v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name).join(',')}]`);

  /**
   * Finding 1. mfe-b pins core to exactly 17.1.0 and mfe-a's `~17.1.1` rejects it, so the newer 17.1.1 is
   * shared and 17.1.0's only row is mfe-b's `scope` row. mfe-c, loaded at runtime with 17.1.0 under `^17.1.0`, accepts the shared 17.1.1
   * and the page maps it onto `imports`. Filed into mfe-b's `scope` row, the next page scoped it to its own
   * 17.1.0 instead: a tear beside anything it shares with mfe-a, and a page that differs across a reload.
   */
  describe('a dynamically loaded copy never joins an island row at its tag', () => {
    let p: ReturnType<typeof portfolio>;
    beforeEach(() => {
      p = portfolio({}, { storage: 'nf-regression-d16-island', realRepositories: true });
    });

    it('keeps the shared build for the loaded remote on the page, after a reload and a warm init', async () => {
      const remotes = [
        entry('team/mfe-a', shared('@fw/core', '17.1.1', '~17.1.1')),
        entry('team/mfe-b', shared('@fw/core', '17.1.0', '17.1.0')),
      ];
      const loaded = entry('team/mfe-c', shared('@fw/core', '17.1.0', '^17.1.0', false));

      await p.runInit(remotes);
      expect(rows(p, '@fw/core')).toEqual([
        '17.1.1:share:[team/mfe-a]',
        '17.1.0:scope:[team/mfe-b]',
      ]);

      p.reload();
      const { actions, merged } = await p.runDynamic(loaded);
      expect(actions['@fw/core']).toEqual({ action: 'skip', covered: ['@fw/core'] });
      expect(resolves(merged, 'team/mfe-c', '@fw/core')).toBe(file('team/mfe-a', '@fw/core'));

      // Its own `skip` row beside the island, so the record rebuilds what the page ran.
      expect(rows(p, '@fw/core')).toEqual([
        '17.1.1:share:[team/mfe-a]',
        '17.1.0:scope:[team/mfe-b]',
        '17.1.0:skip:[team/mfe-c]',
      ]);

      p.reload();
      const warm = await p.runInit([...remotes, loaded]);
      expect(resolves(warm, 'team/mfe-c', '@fw/core')).toBe(file('team/mfe-a', '@fw/core'));
      expect(warm.scopes?.['http://mfe-c/']).toBeUndefined();
    });
  });

  /**
   * Finding 2, and the architect's two follow-ups on the same state. The host mfe-a runs 19.2.0; mfe-b and
   * mfe-c pin 19.1.0 exactly, so they run mfe-b's build as a subpool. anim then has no `share` row: both
   * copies `skip` onto mfe-b through per-consumer overrides, and `imports` never names it. mfe-d, loaded with
   * only anim@19.1.0, joined that `skip` row and got `skip` with nothing `covered`: an unmapped bare
   * specifier. It now shares its own copy.
   */
  describe('a dynamically loaded copy of a member nothing shares still resolves', () => {
    let p: ReturnType<typeof portfolio>;
    beforeEach(() => {
      p = portfolio(
        {},
        { hosts: ['team/mfe-a'], storage: 'nf-regression-d16-unshared', realRepositories: true }
      );
    });

    const remotes = [
      entry(
        'team/mfe-a',
        shared('@fw/core', '19.2.0', '^19.2.0'),
        shared('@fw/common', '19.2.0', '^19.2.0')
      ),
      entry(
        'team/mfe-b',
        shared('@fw/core', '19.1.0', '19.1.0'),
        shared('@fw/anim', '19.1.0', '19.1.0')
      ),
      entry(
        'team/mfe-c',
        shared('@fw/core', '19.1.0', '19.1.0'),
        shared('@fw/anim', '19.1.0', '19.1.0')
      ),
    ];

    const initSubpool = async () => {
      const committed = await p.runInit(remotes);
      expect(p.islands()).toEqual({
        'team/mfe-b': 'subpool team/mfe-b',
        'team/mfe-c': 'subpool team/mfe-b',
      });
      expect(committed.imports['@fw/anim']).toBeUndefined();
      expect(rows(p, '@fw/anim')).toEqual(['19.1.0:skip:[team/mfe-b,team/mfe-c]']);
      p.reload();
    };

    // Every remote and specifier the portfolio ships, and what each resolves to on one map.
    const page = (importMap: ImportMap, loaded: RemoteEntry[]) =>
      Object.fromEntries(
        [...remotes, ...loaded].flatMap(e =>
          e.shared.map(s => [
            `${e.name}|${s.packageName}`,
            resolves(importMap, e.name, s.packageName),
          ])
        )
      );

    it('shares the loaded copy, on the page and after a reload and a warm init', async () => {
      await initSubpool();
      const mfeD = entry('team/mfe-d', shared('@fw/anim', '19.1.0', '^19.1.0'));

      const { actions, merged } = await p.runDynamic(mfeD);
      expect(actions['@fw/anim']!.action).toBe('share');
      expect(resolves(merged, 'team/mfe-d', '@fw/anim')).toBe(file('team/mfe-d', '@fw/anim'));

      p.reload();
      const warm = await p.runInit([...remotes, mfeD]);
      expect(resolves(warm, 'team/mfe-d', '@fw/anim')).toBe(file('team/mfe-d', '@fw/anim'));
      expect(page(warm, [mfeD])).toEqual(page(merged, [mfeD]));
    });
  });

  /**
   * D28. A record the orchestrator never writes itself: a remote lists `@fw/core` twice, at 1.0.1 and at
   * 1.0.0 with another file. A build ships one copy per member, so the election, the dynamic gate and the
   * no-tear oracle all read its first row, whole: the build is core 1.0.1 beside common 1.0.0. The gate's own
   * first-row read is pinned in pool-dynamic-externals.spec.ts.
   */
  describe('D28: a duplicated row is read as the first one', () => {
    let p: ReturnType<typeof portfolio>;
    beforeEach(() => {
      p = portfolio({}, { storage: 'nf-regression-d28', realRepositories: true });
    });

    // mfe-d disagrees with the map's core 1.0.1, so it takes the map's files only because a build shipped
    // core 1.0.1 beside common 1.0.0: mfe-s's first row. Its second row shipped no such pair.
    it("witnesses a load by a committed build's first row", async () => {
      await p.runInit([
        entry(
          'team/mfe-s',
          shared('@fw/core', '1.0.1', '~1.0.0'),
          { ...shared('@fw/core', '1.0.0', '~1.0.0'), entries: { '@fw/core': 'core-100.js' } },
          shared('@fw/common', '1.0.0', '~1.0.0')
        ),
      ]);
      expect(rows(p, '@fw/core')).toEqual(['1.0.1:share:[team/mfe-s]', '1.0.0:skip:[team/mfe-s]']);

      p.reload();
      const { merged } = await p.runDynamic(
        entry(
          'team/mfe-d',
          shared('@fw/core', '1.0.0', '~1.0.0', false),
          shared('@fw/common', '1.0.0', '~1.0.0', false)
        )
      );
      expect(p.islands()).toEqual({});
      expect(resolves(merged, 'team/mfe-d', '@fw/core')).toBe(file('team/mfe-s', '@fw/core'));
      expect(resolves(merged, 'team/mfe-d', '@fw/common')).toBe(file('team/mfe-s', '@fw/common'));
    });
  });

  /**
   * A remote that serves some members itself could still publish a global file: rule 5 gave an
   * agreeing build every file at a tag round 1 publishes, and both the extension and round 1's same-tag loans
   * took files from such builds. Import-map scopes are keyed by URL, so that file's own imports resolve in its
   * owner's scope, and every remote taking it also ran the owner's private copies one hop in: a split. Now only
   * a build that takes every member it ships from the global map may publish one. Both cases are one pool
   * under one npm-scope label, no label noise; the harness's no-tear oracle failed each with a `split` for c.
   */
  describe('a build serving some members itself publishes no global file', () => {
    const CORE = '@ng/core';
    const ROUTER = '@ng/router';
    const MATERIAL = '@ng/material';
    const CDK = '@ng/cdk';

    const copy = (remote: string, entries?: Record<string, string>) => ({
      remote,
      req: '^17.3.0',
      strict: false,
      entries,
    });

    // The host w ships cdk's root; l and c lend cdk/overlay at w's tag. They ship different material
    // entrypoints at different tags, so neither serves the other and material is not published. The overlay
    // file was l's, which binds l's material 17.3.1, and c ran it beside its own material 17.3.0.
    it('through a borrowed entrypoint', async () => {
      const p = portfolio(
        { w: 'http://w/', l: 'http://l/', c: 'http://c/' },
        { storage: 'nf-regression-t1-loan', hosts: ['w'] }
      );
      p.seed(CORE, [
        { ...p.version('17.3.0', CORE, [copy('w'), copy('l'), copy('c')]), host: true },
      ]);
      p.seed(CDK, [
        {
          ...p.version('17.3.0', CDK, [
            copy('w', { '@ng/cdk': '@ng/cdk.js' }),
            copy('l', { '@ng/cdk/overlay': '@ng/cdk/overlay.js' }),
            copy('c', { '@ng/cdk/overlay': '@ng/cdk/overlay.js' }),
          ]),
          host: true,
        },
      ]);
      p.seed(MATERIAL, [
        p.version('17.3.1', MATERIAL, [copy('l', { '@ng/material/sort': '@ng/material/sort.js' })]),
        p.version('17.3.0', MATERIAL, [
          copy('c', { '@ng/material/table': '@ng/material/table.js' }),
        ]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports).toEqual({
        [CORE]: 'http://w/@ng/core.js',
        [CDK]: 'http://w/@ng/cdk.js',
      });
      expect(p.islands()).toEqual({ l: 'uncovered', c: 'uncovered' });
    });

    // The host w wins with core+router@17.3.0. n's build (Y@17.3.1, Z@17.3.5) serves m1 and m2 (router and
    // Y at 17.3.1 and 17.3.0, `^17.3.0`), so they form subpool n. The extension publishes Y@17.3.1, as n is
    // the only agreeing remote shipping Y (m1 and m2 disagree on router), and m1 and m2 move onto the global
    // map, which n's build witnesses. But n serves Z itself (q ships it at 17.3.4, both exact), so the
    // fixpoint drops Y and takes m1 and m2 off the global map again. They went `alone` and each served its
    // whole family itself; now they go back to the later rounds and n's subpool takes them in again.
    it('sends a remote the fixpoint takes off the global map back to the subpool rounds', async () => {
      const Y = '@ng/y';
      const Z = '@ng/z';
      const p = portfolio(
        { w: 'http://w/', n: 'http://n/', q: 'http://q/', m1: 'http://m1/', m2: 'http://m2/' },
        { storage: 'nf-regression-t1-demoted', hosts: ['w'] }
      );
      const at = (remote: string, req = '^17.3.0') => ({ remote, req, strict: false });
      p.seed(CORE, [
        {
          ...p.version(
            '17.3.0',
            CORE,
            ['w', 'n', 'q', 'm1', 'm2'].map(r => at(r))
          ),
          host: true,
        },
      ]);
      p.seed(ROUTER, [
        p.version('17.3.1', ROUTER, [at('m1'), at('m2')]),
        { ...p.version('17.3.0', ROUTER, [at('w'), at('n')]), host: true },
      ]);
      p.seed(Y, [p.version('17.3.1', Y, [at('n')]), p.version('17.3.0', Y, [at('m1'), at('m2')])]);
      p.seed(Z, [
        p.version('17.3.5', Z, [at('n', '17.3.5')]),
        p.version('17.3.4', Z, [at('q', '17.3.4')]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports).toEqual({
        [CORE]: 'http://w/@ng/core.js',
        [ROUTER]: 'http://w/@ng/router.js',
      });
      expect(p.islands()).toEqual({
        n: 'subpool n',
        m1: 'subpool n',
        m2: 'subpool n',
        q: 'uncovered',
      });
      expect(importMap.scopes?.['http://m1/']).toEqual({
        [ROUTER]: 'http://n/@ng/router.js',
        [Y]: 'http://n/@ng/y.js',
      });
    });

    // As above, but n's subpool survives the extension: m3 (router@17.3.1, Z@17.3.5) stays in it, as the
    // extended global tags do not serve Z, while m1 (router@17.3.1, Y@17.3.0) moves onto the global map. When
    // the fixpoint drops Y again, no new subpool can form around m1, so it has to rejoin subpool n, the one
    // it left, instead of going `alone` and serving its whole family itself.
    it('returns a remote the fixpoint takes off the global map to the subpool it left', async () => {
      const Y = '@ng/y';
      const Z = '@ng/z';
      const p = portfolio(
        { w: 'http://w/', n: 'http://n/', q: 'http://q/', m1: 'http://m1/', m3: 'http://m3/' },
        { storage: 'nf-regression-t1-rejoin', hosts: ['w'] }
      );
      const at = (remote: string, req = '^17.3.0') => ({ remote, req, strict: false });
      p.seed(CORE, [
        {
          ...p.version(
            '17.3.0',
            CORE,
            ['w', 'n', 'q', 'm1', 'm3'].map(r => at(r))
          ),
          host: true,
        },
      ]);
      p.seed(ROUTER, [
        p.version('17.3.1', ROUTER, [at('m3'), at('m1')]),
        { ...p.version('17.3.0', ROUTER, [at('w'), at('n')]), host: true },
      ]);
      p.seed(Y, [p.version('17.3.1', Y, [at('n')]), p.version('17.3.0', Y, [at('m1')])]);
      p.seed(Z, [
        p.version('17.3.5', Z, [at('n', '17.3.5'), at('m3')]),
        p.version('17.3.4', Z, [at('q', '17.3.4')]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports).toEqual({
        [CORE]: 'http://w/@ng/core.js',
        [ROUTER]: 'http://w/@ng/router.js',
      });
      // Without the way back, m1 went `uncovered` and scoped its own core, router and Y.
      expect(p.islands()).toEqual({
        n: 'subpool n',
        m1: 'subpool n',
        m3: 'subpool n',
        q: 'uncovered',
      });
      expect(importMap.scopes?.['http://m1/']).toEqual({
        [ROUTER]: 'http://n/@ng/router.js',
        [Y]: 'http://n/@ng/y.js',
      });
    });

    // The same way back for a remote round 1 placed. The host w ships core alone; l lends it `core/testing`
    // at 17.3.0, so round 1 serves a (core and core/testing at 17.3.1). l ships router too, so it serves
    // itself and m (router@17.3.1) as subpool l. But l runs router off the global map, so it publishes
    // nothing: the fixpoint drops `core/testing` and takes a off the global map again. a was never in a
    // subpool and no new one forms around it; it joins subpool l, whose build serves it, instead of going
    // `alone` and serving core itself.
    it('puts a remote the fixpoint takes off the global map in a subpool whose build serves it', async () => {
      const TESTING = '@ng/core/testing';
      const p = portfolio(
        { w: 'http://w/', l: 'http://l/', a: 'http://a/', m: 'http://m/' },
        { storage: 'nf-regression-t1-round1', hosts: ['w'] }
      );
      const at = (remote: string, entries?: Record<string, string>) => ({
        remote,
        req: '^17.3.0',
        strict: false,
        entries,
      });
      const withTesting = (remote: string) =>
        at(remote, { [CORE]: `${remote}-core.js`, [TESTING]: `${remote}-testing.js` });
      p.seed(CORE, [
        p.version('17.3.1', CORE, [withTesting('a')]),
        { ...p.version('17.3.0', CORE, [at('w'), withTesting('l'), at('m')]), host: true },
      ]);
      p.seed(ROUTER, [
        p.version('17.3.1', ROUTER, [at('m')]),
        p.version('17.3.0', ROUTER, [at('l')]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports).toEqual({ [CORE]: 'http://w/@ng/core.js' });
      // Without it, a went `uncovered` and scoped its own core and core/testing.
      expect(p.islands()).toEqual({ a: 'subpool l', l: 'subpool l', m: 'subpool l' });
      expect(importMap.scopes?.['http://a/']).toEqual({
        [CORE]: 'http://l/l-core.js',
        [TESTING]: 'http://l/l-testing.js',
      });
    });

    // A flat and a dense build of one entrypoint. The host w ships core+router; p ships `@ng/cdk/overlay` as
    // a package of its own, n and x as an entry of `@ng/cdk`, all at 17.3.0. The extension publishes the
    // overlay (p, n and x agree on it) and p moves global, but n and x ship forms at 17.3.1 and 17.3.0
    // (exact), so they serve forms themselves and publish nothing. The coverage check let n's and x's dense
    // copies onto the global map, since p publishes the overlay at their tag. The import map maps a
    // specifier from whichever external reaches it first, so with `@ng/cdk` stored first it took n's overlay
    // file, which binds n's forms 17.3.1, and x ran it beside its own forms 17.3.0. A copy that serves some
    // member itself now takes a file global only where a publishing copy of the same member lists it.
    for (const denseFirst of [true, false])
      it(`publishes no file of a build serving some members itself from a dense record (dense first: ${denseFirst})`, async () => {
        const OVERLAY = '@ng/cdk/overlay';
        const FORMS = '@ng/forms';
        const p = portfolio(
          { w: 'http://w/', p: 'http://p/', n: 'http://n/', x: 'http://x/' },
          { storage: `nf-regression-t1-dense-${denseFirst}`, hosts: ['w'] }
        );
        const at = (remote: string, entries?: Record<string, string>, req = '^17.3.0') => ({
          remote,
          req,
          strict: false,
          entries,
        });
        p.seed(CORE, [
          {
            ...p.version(
              '17.3.0',
              CORE,
              ['w', 'p', 'n', 'x'].map(r => at(r))
            ),
            host: true,
          },
        ]);
        p.seed(ROUTER, [{ ...p.version('17.3.0', ROUTER, [at('w')]), host: true }]);
        const dense = () =>
          p.seed(CDK, [
            p.version('17.3.0', CDK, [
              at('n', { [OVERLAY]: 'n-overlay.js' }),
              at('x', { [OVERLAY]: 'x-overlay.js' }),
            ]),
          ]);
        const flat = () => p.seed(OVERLAY, [p.version('17.3.0', OVERLAY, [at('p')])]);
        if (denseFirst) {
          dense();
          flat();
        } else {
          flat();
          dense();
        }
        p.seed(FORMS, [
          p.version('17.3.1', FORMS, [at('n', undefined, '17.3.1')]),
          p.version('17.3.0', FORMS, [at('x', undefined, '17.3.0')]),
        ]);

        const importMap = await p.runInit();

        expect(importMap.imports).toEqual({
          [CORE]: 'http://w/@ng/core.js',
          [ROUTER]: 'http://w/@ng/router.js',
          [OVERLAY]: 'http://p/@ng/cdk/overlay.js',
        });
        expect(p.islands()).toEqual({ n: 'uncovered', x: 'uncovered' });
        expect(importMap.scopes?.['http://x/']).toEqual({
          [OVERLAY]: 'http://x/x-overlay.js',
          [FORMS]: 'http://x/@ng/forms.js',
        });
      });

    // A drop that leaves a second remote without a publisher. The host w ships core and router; l agrees and
    // lends core/testing and router/upgrade at 17.3.0, but is not served, as nothing covers Z (q ships it at
    // another tag, both exact). r ships upgrade at 17.3.1, so it disagrees and lends nothing, yet its range
    // takes the borrowed upgrade; x's range takes the borrowed testing: both go global. Only l, off the map,
    // ships upgrade at 17.3.0, so the fixpoint drops it and takes r off the map. r was the only global remote
    // shipping testing at 17.3.0, so a second pass drops that too and takes x off the map. l's build then
    // serves all three as a subpool.
    it('drops what a remote it took off the global map published, and whoever needed that', async () => {
      const TESTING = '@ng/core/testing';
      const UPGRADE = '@ng/router/upgrade';
      const Z = '@ng/z';
      const p = portfolio(
        { w: 'http://w/', l: 'http://l/', r: 'http://r/', x: 'http://x/', q: 'http://q/' },
        { storage: 'nf-regression-t1-cascade', hosts: ['w'] }
      );
      const testing = (remote: string) => copy(remote, { [TESTING]: `${remote}-testing.js` });
      const upgrade = (remote: string) => copy(remote, { [UPGRADE]: `${remote}-upgrade.js` });
      p.seed(CORE, [
        p.version('17.3.2', CORE, [testing('x')]),
        { ...p.version('17.3.0', CORE, [copy('w'), testing('l'), testing('r')]), host: true },
      ]);
      p.seed(ROUTER, [
        p.version('17.3.1', ROUTER, [upgrade('r')]),
        { ...p.version('17.3.0', ROUTER, [copy('w'), upgrade('l')]), host: true },
      ]);
      p.seed(Z, [
        p.version('17.3.5', Z, [{ ...copy('l'), req: '17.3.5' }]),
        p.version('17.3.4', Z, [{ ...copy('q'), req: '17.3.4' }]),
      ]);

      const importMap = await p.runInit();

      expect(importMap.imports).toEqual({
        [CORE]: 'http://w/@ng/core.js',
        [ROUTER]: 'http://w/@ng/router.js',
      });
      // With one pass, x stayed global and the map took core/testing from x's own 17.3.2 file.
      expect(p.islands()).toEqual({
        l: 'subpool l',
        r: 'subpool l',
        x: 'subpool l',
        q: 'uncovered',
      });
      expect(importMap.scopes?.['http://x/']).toEqual({ [TESTING]: 'http://l/l-testing.js' });
    });
  });
});
