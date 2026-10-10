import type { RemoteEntry, RemoteInfo } from 'lib/core/1.domain';
import { Optional } from 'lib/utils/optional';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { portfolio } from 'lib/testing/pooling/portfolio';
import {
  labelSharedInfoByNpmScope,
  labelStoredByNpmScope,
} from 'lib/testing/pooling/label-by-npm-scope';

/**
 * The ONE place pooling's warn wording is pinned, word for word: every init sentence (`missWarning` with
 * each of its endings and its witness-miss form, and the keeps-subpool line in `pool-shared-externals.ts`)
 * and every dynamic one (`selfServeWarning` and the cache miss in `pool-dynamic-externals.ts`). These
 * sentences are for humans. Every other test, unit or e2e, reads islands from the stored record
 * (`poolCause` / `servedBy`), never from this text.
 *
 * The record stores no gap, so this spec is also the ONLY guard for gap selection: which `member@tag` or
 * specifier a warning names, and which build it calls elected or closest. A change to how pooling picks
 * the gap must update the expectations here deliberately.
 *
 * A failure here means the wording or the gap changed. If that was deliberate, update the expectation
 * below and nothing else; if a second test starts failing with it, that test is parsing the log and should
 * read the record instead.
 */
describe('island warnings (contract)', () => {
  const SCOPE = Object.fromEntries(
    [
      'host',
      'mfe-a',
      'mfe-b',
      'mfe-c',
      'mfe-d',
      'mfe-e',
      'mfe-f',
      'legacy-a',
      'legacy-b',
      'r0',
      'r1',
      'r2',
    ].map(n => [`team/${n}`, `http://${n}/`])
  );

  let p: ReturnType<typeof portfolio>;
  beforeEach(() => {
    p = portfolio(SCOPE, { hosts: ['team/host'], storage: 'nf-island-warnings' });
  });

  const warnings = () => vi.mocked(p.config.log.warn).mock.calls.map(([, msg]) => msg);

  const entry = (name: string, shared: [string, string, string][], strict = true): RemoteEntry =>
    ({
      name,
      url: `${SCOPE[name]}remoteEntry.json`,
      exposes: [],
      shared: labelSharedInfoByNpmScope(
        shared.map(([pkg, version, requiredVersion]) =>
          mockSharedInfo(pkg, { version, requiredVersion, singleton: true, strictVersion: strict })
        )
      ),
    }) as RemoteEntry;

  describe('init', () => {
    it('incompatible: a range rejects the elected build', async () => {
      p.seed('@framework/core', [
        p.version('22.1.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
        p.version('22.0.5', '@framework/core', [{ remote: 'team/mfe-b', req: '~22.0.5' }]),
      ]);
      p.seed('@framework/router', [
        p.version('22.1.0', '@framework/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({ 'team/mfe-b': 'incompatible' });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:framework] 'team/mfe-b' is islanded: its range rejects '@framework/core@22.1.0' of the elected build 'team/mfe-a'. All 1 of its members are scoped for it.",
      ]);
    });

    it('uncovered: the elected build lacks an entrypoint the remote imports', async () => {
      // The host's pin elects its build, which ships no router.
      p.seed('@framework/core', [
        p.version('22.1.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
        p.version('22.0.5', '@framework/core', [
          { remote: 'team/host', req: '^22.0.0', host: true },
        ]),
      ]);
      p.seed('@framework/router', [
        p.version('22.1.0', '@framework/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({ 'team/mfe-a': 'uncovered' });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:framework] 'team/mfe-a' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '@framework/router', closest 'team/host'). All 2 of its members are scoped for it.",
      ]);
    });

    it('subpool: a build serving others, and a remote running it', async () => {
      // legacy-b's ~21.2.0 takes legacy-a's 21.2.18, so both leave round 1 into legacy-a's subpool.
      p.seed('@framework/core', [
        p.version('22.0.8', '@framework/core', [
          { remote: 'team/mfe-a', req: '~22.0.3' },
          { remote: 'team/mfe-b', req: '~22.0.3' },
        ]),
        p.version('21.2.18', '@framework/core', [{ remote: 'team/legacy-a', req: '~21.2.0' }]),
        p.version('21.2.15', '@framework/core', [{ remote: 'team/legacy-b', req: '~21.2.0' }]),
      ]);
      p.seed('@framework/router', [
        p.version('22.0.8', '@framework/router', [
          { remote: 'team/mfe-a', req: '~22.0.3' },
          { remote: 'team/mfe-b', req: '~22.0.3' },
        ]),
        p.version('21.2.18', '@framework/router', [{ remote: 'team/legacy-a', req: '~21.2.0' }]),
        p.version('21.2.15', '@framework/router', [{ remote: 'team/legacy-b', req: '~21.2.0' }]),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({
        'team/legacy-a': 'subpool team/legacy-a',
        'team/legacy-b': 'subpool team/legacy-a',
      });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:framework] 'team/legacy-a' is islanded: its range rejects '@framework/core@22.0.8' of the elected build 'team/mfe-a'. Its build serves subpool 'team/legacy-a': its 2 members and 1 other remote(s).",
        "[__GLOBAL__][pool:framework] 'team/legacy-b' is islanded: its range rejects '@framework/core@22.0.8' of the elected build 'team/mfe-a'. It runs in subpool 'team/legacy-a' for all 2 of its members.",
      ]);
    });

    it('subpool: an uncovered remote running another build', async () => {
      // The host's pin elects its build, which ships no cdk. mfe-c's ^17.0.0 takes mfe-b's cdk 17.1.0, so
      // mfe-b's build serves both; cdk ships at two tags, so the global map cannot add it.
      p.seed('@framework/core', [
        p.version('17.0.0', '@framework/core', [
          { remote: 'team/host', req: '^17.0.0', host: true },
          { remote: 'team/mfe-b', req: '^17.0.0' },
          { remote: 'team/mfe-c', req: '^17.0.0' },
        ]),
      ]);
      p.seed('@framework/common', [
        p.version('17.0.0', '@framework/common', [
          { remote: 'team/host', req: '^17.0.0', host: true },
        ]),
      ]);
      p.seed('@framework/cdk', [
        p.version('17.1.0', '@framework/cdk', [{ remote: 'team/mfe-b', req: '~17.1.0' }]),
        p.version('17.0.0', '@framework/cdk', [{ remote: 'team/mfe-c', req: '^17.0.0' }]),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({
        'team/mfe-b': 'subpool team/mfe-b',
        'team/mfe-c': 'subpool team/mfe-b',
      });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:framework] 'team/mfe-b' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '@framework/cdk', closest 'team/host'). Its build serves subpool 'team/mfe-b': its 2 members and 1 other remote(s).",
        "[__GLOBAL__][pool:framework] 'team/mfe-c' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '@framework/cdk', closest 'team/host'). It runs in subpool 'team/mfe-b' for all 2 of its members.",
      ]);
    });

    it('agreeing: a remote takes the elected files and serves the rest itself', async () => {
      // b and c agree with a on core but ship cdk at two tags, so cdk cannot be published for both.
      p.seed('@framework/core', [
        p.version('17.0.0', '@framework/core', [
          { remote: 'team/mfe-a', req: '^17.0.0' },
          { remote: 'team/mfe-b', req: '^17.0.0' },
          { remote: 'team/mfe-c', req: '^17.0.0' },
        ]),
      ]);
      p.seed('@framework/common', [
        p.version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      ]);
      p.seed('@framework/cdk', [
        p.version('17.1.0', '@framework/cdk', [{ remote: 'team/mfe-b', req: '~17.1.0' }]),
        p.version('17.0.0', '@framework/cdk', [{ remote: 'team/mfe-c', req: '~17.0.0' }]),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({ 'team/mfe-b': 'uncovered', 'team/mfe-c': 'uncovered' });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:framework] 'team/mfe-b' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '@framework/cdk', closest 'team/mfe-a'). It takes the elected files where its versions match; the rest of its 2 members are scoped for it.",
        "[__GLOBAL__][pool:framework] 'team/mfe-c' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '@framework/cdk', closest 'team/mfe-a'). It takes the elected files where its versions match; the rest of its 2 members are scoped for it.",
      ]);
    });

    it('keeps subpool: the elected build would serve a build another remote still needs', async () => {
      // mfe-d is the only agreeing contributor and gets animations published. mfe-e runs core@17.1.0 with
      // ^17, mfe-f pins ~17.1.0 and joins mfe-e's subpool; the global map would serve mfe-e but not mfe-f,
      // so the subpool stays whole.
      p.seed('@framework/core', [
        p.version('17.1.0', '@framework/core', [
          { remote: 'team/mfe-e', req: '^17.0.0' },
          { remote: 'team/mfe-f', req: '~17.1.0' },
        ]),
        p.version('17.0.0', '@framework/core', [
          { remote: 'team/mfe-a', req: '^17.0.0' },
          { remote: 'team/mfe-b', req: '^17.0.0' },
          { remote: 'team/mfe-c', req: '^17.0.0' },
          { remote: 'team/mfe-d', req: '~17.0.0' },
        ]),
      ]);
      p.seed('@framework/forms', [
        p.version('17.0.0', '@framework/forms', [
          { remote: 'team/mfe-a', req: '^17.0.0' },
          { remote: 'team/mfe-b', req: '^17.0.0' },
          { remote: 'team/mfe-c', req: '^17.0.0' },
        ]),
      ]);
      p.seed('@framework/animations', [
        p.version('17.0.0', '@framework/animations', [
          { remote: 'team/mfe-d', req: '^17.0.0' },
          { remote: 'team/mfe-e', req: '^17.0.0' },
          { remote: 'team/mfe-f', req: '^17.0.0' },
        ]),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({
        'team/mfe-e': 'subpool team/mfe-e',
        'team/mfe-f': 'subpool team/mfe-e',
      });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:framework] 'team/mfe-e' keeps subpool 'team/mfe-e': the elected build would serve it, but 1 other remote(s) in it need its build.",
        "[__GLOBAL__][pool:framework] 'team/mfe-f' is islanded: its range rejects '@framework/core@17.0.0' of the elected build 'team/mfe-a'. It runs in subpool 'team/mfe-e' for all 2 of its members.",
      ]);
    });

    it('witness miss: no build shipped the pair the extended global tags would serve', async () => {
      // pooling.regression.spec.ts, "extension witness", first case. r0 accepts every tag the map
      // publishes, so the sentence names the unwitnessed gap rather than a version it rejects.
      const caret = (tag: string, external: string, remote: string) =>
        p.version(tag, external, [{ remote, req: `^${tag}`, strict: false }]);
      p.seed('@lib/m0', [
        caret('18.0.0', '@lib/m0', 'team/r0'),
        caret('18.0.1', '@lib/m0', 'team/r1'),
      ]);
      p.seed('@lib/m1', [
        caret('18.0.0', '@lib/m1', 'team/r0'),
        caret('18.0.1', '@lib/m1', 'team/r2'),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({ 'team/r0': 'uncovered' });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:lib] 'team/r0' serves its own family: no build shipped its entrypoints together at the elected versions (gap '@lib/m1', closest 'team/r1'). All 2 of its members are scoped for it.",
      ]);
    });
  });

  // Scenarios whose diagnostic content (which gap, which closest build) the e2e suite used to assert in
  // the browser; the record cannot express it, so it is pinned here on the same fixtures.
  describe('which gap and which build the init sentence names', () => {
    it('names the consumer whose build serves the most remotes as the elected build', async () => {
      // e2e provenance: "serves a consumer its own build when no shared build ships both members".
      p.seed('@angular/core', [
        p.version('22.0.5', '@angular/core', [
          { remote: 'team/mfe-a', req: '^22.0.0' },
          { remote: 'team/mfe-c', req: '^22.0.0' },
        ]),
      ]);
      p.seed('@angular/router', [
        p.version('22.1.0', '@angular/router', [{ remote: 'team/mfe-b', req: '^22.1.0' }]),
        p.version('22.0.5', '@angular/router', [{ remote: 'team/mfe-c', req: '^22.0.0' }]),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({ 'team/mfe-b': 'incompatible' });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:angular] 'team/mfe-b' is islanded: its range rejects '@angular/router@22.0.5' of the elected build 'team/mfe-c'. All 1 of its members are scoped for it.",
      ]);
    });

    it('names the host as the closest build when it ships no router', async () => {
      // e2e provenance: #63's second repro without the consumer as router basis.
      p.seed('@angular/core', [
        p.version('22.0.5', '@angular/core', [
          { remote: 'team/host', req: '^22.0.0', host: true },
          { remote: 'team/mfe-b', req: '^22.0.0' },
        ]),
      ]);
      p.seed('@angular/router', [
        p.version('22.1.0', '@angular/router', [{ remote: 'team/mfe-a', req: '^22.1.0' }]),
        p.version('22.0.5', '@angular/router', [{ remote: 'team/mfe-b', req: '^22.0.0' }]),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({ 'team/mfe-a': 'uncovered', 'team/mfe-b': 'uncovered' });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:angular] 'team/mfe-b' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '@angular/router', closest 'team/host'). It takes the elected files where its versions match; the rest of its 2 members are scoped for it.",
        "[__GLOBAL__][pool:angular] 'team/mfe-a' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '@angular/router', closest 'team/host'). It takes the elected files where its versions match; the rest of its 1 members are scoped for it.",
      ]);
    });

    it('names the pool a vendor lockstep pair was labelled into', async () => {
      // e2e provenance: material and cdk pool with core under `angular`, the npm scope label.
      p.seed('@angular/core', [
        p.version('22.0.5', '@angular/core', [
          { remote: 'team/mfe-a', req: '^22.0.0' },
          { remote: 'team/mfe-b', req: '^22.0.0' },
        ]),
      ]);
      p.seed('@angular/material', [
        p.version('22.0.5', '@angular/material', [
          { remote: 'team/mfe-a', req: '^22.0.0' },
          { remote: 'team/mfe-c', req: '^22.0.0' },
        ]),
      ]);
      p.seed('@angular/cdk', [
        p.version('22.1.0', '@angular/cdk', [{ remote: 'team/mfe-b', req: '^22.1.0' }]),
        p.version('22.0.5', '@angular/cdk', [{ remote: 'team/mfe-c', req: '^22.0.0' }]),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({ 'team/mfe-b': 'uncovered', 'team/mfe-c': 'uncovered' });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:angular] 'team/mfe-b' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '@angular/cdk', closest 'team/mfe-a'). It takes the elected files where its versions match; the rest of its 2 members are scoped for it.",
        "[__GLOBAL__][pool:angular] 'team/mfe-c' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '@angular/cdk', closest 'team/mfe-a'). It takes the elected files where its versions match; the rest of its 2 members are scoped for it.",
      ]);
    });

    it('names the member the closest build lacks, not the one it ships at another tag', async () => {
      // e2e asymmetric: "self-serves the sole provider whose own tag lost the election".
      p.seed('@angular/core', [
        p.version('21.2.3', '@angular/core', [{ remote: 'team/mfe-a', req: '~21.2.0' }]),
        p.version('21.2.2', '@angular/core', [{ remote: 'team/mfe-b', req: '~21.2.0' }]),
      ]);
      p.seed('@angular/router', [
        p.version('21.2.3', '@angular/router', [{ remote: 'team/mfe-a', req: '~21.2.0' }]),
      ]);
      p.seed('@angular/forms', [
        p.version('21.2.2', '@angular/forms', [{ remote: 'team/mfe-b', req: '~21.2.0' }]),
      ]);

      await p.runInit();

      expect(p.islands()).toEqual({ 'team/mfe-b': 'uncovered' });
      expect(warnings()).toEqual([
        "[__GLOBAL__][pool:angular] 'team/mfe-b' serves its own family: no elected build offers every entrypoint it imports at a version it accepts (gap '@angular/forms', closest 'team/mfe-a'). All 2 of its members are scoped for it.",
      ]);
    });

    it('prefixes the share scope a pool was elected in', async () => {
      // e2e membership: "pools each shareScope separately".
      const seedIn = (name: string, versions: ReturnType<typeof p.version>[]) =>
        p.adapters.sharedExternalsRepo.addOrUpdate(
          name,
          labelStoredByNpmScope({ [name]: { dirty: true, versions } })[name]!,
          'widgets'
        );
      for (const name of ['@angular/core', '@angular/router'])
        seedIn(name, [
          p.version('18.0.0', name, [
            { remote: 'team/mfe-a', req: '^18.0.0' },
            { remote: 'team/mfe-c', req: '^18.0.0' },
          ]),
          p.version('17.0.0', name, [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
        ]);

      await p.runInit();

      expect(warnings()).toEqual([
        "[widgets][pool:angular] 'team/mfe-b' is islanded: its range rejects '@angular/core@18.0.0' of the elected build 'team/mfe-a'. All 2 of its members are scoped for it.",
      ]);
    });
  });

  describe('debug', () => {
    const debugs = () => vi.mocked(p.config.log.debug).mock.calls.map(([, msg]) => msg);

    it('a pool label nothing else joined: debug, not a warning', async () => {
      // e2e membership: "pools nothing for a label that joins no other external". An unscoped name, so the
      // explicit (misspelt) label is the only one.
      p.seed('core-pkg', [
        p.version('18.0.0', 'core-pkg', [
          { remote: 'team/mfe-a', req: '^18.0.0', pool: 'framwork' },
          { remote: 'team/mfe-b', req: '^18.0.0' },
        ]),
      ]);

      await p.runInit();

      expect(warnings()).toEqual([]);
      expect(debugs()).toContain(
        "[__GLOBAL__] 'core-pkg' has a 'pool' label that joins no other external; likely a typo or a missing sibling."
      );
    });

    it('re-electing: one line per dirty scope with pools', async () => {
      p.seed('@framework/core', [
        p.version('22.1.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      ]);
      p.seed('@framework/router', [
        p.version('22.1.0', '@framework/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      ]);

      await p.runInit();

      expect(debugs().filter(msg => msg.includes('re-electing'))).toEqual([
        '[__GLOBAL__] re-electing 1 pool(s): 2 dirty external(s).',
      ]);
    });
  });

  describe('dynamic', () => {
    // A committed family from mfe-a, so the dynamic load is judged against a pooled scope.
    const commit = async () => {
      p.seed('@framework/core', [
        p.version('22.1.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      ]);
      p.seed('@framework/router', [
        p.version('22.1.0', '@framework/router', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      ]);
      await p.runInit();
      vi.mocked(p.config.log.warn).mockClear();
    };

    it('incompatible: a range rejects the committed map', async () => {
      await commit();

      await p.runDynamic(
        entry('team/mfe-b', [
          ['@framework/core', '21.2.0', '~21.2.0'],
          ['@framework/router', '21.2.0', '~21.2.0'],
        ])
      );

      expect(p.islands()).toEqual({ 'team/mfe-b': 'incompatible' });
      // update-cache warns per rejected member first; those lines are not island sentences.
      expect(warnings()).toContainEqual(
        "[__GLOBAL__] 'team/mfe-b' is islanded: its range rejects '@framework/core@22.1.0' of the committed map. All 2 of its members are scoped for it."
      );
    });

    it('uncovered: the committed map lacks an entrypoint the remote imports', async () => {
      await commit();

      await p.runDynamic(
        entry('team/mfe-b', [
          ['@framework/router', '22.0.5', '^22.0.0'],
          ['@framework/forms', '22.0.5', '^22.0.0'],
        ])
      );

      expect(p.islands()).toEqual({ 'team/mfe-b': 'uncovered' });
      expect(warnings()).toEqual([
        "[__GLOBAL__] 'team/mfe-b' serves its own family: no committed build offers every entrypoint it imports at a version it accepts (gap '@framework/forms'). All 2 of its members are scoped for it.",
      ]);
    });

    it('unshipped: no committed build shipped the combination the map serves', async () => {
      // mfe-a ships only core and mfe-c only router, so the map serves the pair from two builds; mfe-b
      // accepts both tags but ships its own, and no committed build witnesses the pair.
      p.seed('@framework/core', [
        p.version('22.1.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^22.0.0' }]),
      ]);
      p.seed('@framework/router', [
        p.version('22.1.0', '@framework/router', [{ remote: 'team/mfe-c', req: '^22.0.0' }]),
      ]);
      await p.runInit();
      vi.mocked(p.config.log.warn).mockClear();

      await p.runDynamic(
        entry('team/mfe-b', [
          ['@framework/core', '22.0.5', '^22.0.0'],
          ['@framework/router', '22.0.5', '^22.0.0'],
        ])
      );

      expect(p.islands()).toEqual({ 'team/mfe-b': 'uncovered' });
      expect(warnings()).toEqual([
        "[__GLOBAL__] 'team/mfe-b' serves its own family: no committed build shipped the map's combination for it. All 2 of its members are scoped for it.",
      ]);
    });

    it('unmapped: the build serving a named scope is not in the cache', async () => {
      p = portfolio(SCOPE, {
        hosts: ['team/host'],
        storage: 'nf-island-warnings-team',
        scope: 'team',
      });
      await commit();
      const mfeB = entry('team/mfe-b', [
        ['@framework/core', '22.1.0', '^22.0.0'],
        ['@framework/router', '22.1.0', '^22.0.0'],
      ]);
      mfeB.shared.forEach(s => (s.shareScope = 'team'));
      const updated = await p.drivers.updateCache(mfeB);
      // mfe-a's remote info goes after update-cache, which names its files for the resolver's override:
      // a named scope has no `imports` to inherit, so pooling cannot name them either.
      const tryGet = p.adapters.remoteInfoRepo.tryGet;
      p.adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
        name === 'team/mfe-a' ? Optional.empty<RemoteInfo>() : tryGet(name)
      );

      await p.drivers.poolDynamicExternals(updated);

      expect(p.islands()).toEqual({ 'team/mfe-b': 'uncovered' });
      expect(warnings()).toEqual([
        "[team][team/mfe-b] 'team/mfe-a' is not in the cache, so its files cannot be mapped.",
      ]);
    });
  });
});
