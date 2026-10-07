import type { ForPoolingSharedExternals } from '../../driver-ports/init/for-pooling-shared-externals.port';
import type { DrivingContract } from '../../driving-ports/driving.contract';
import { createPoolSharedExternals } from './pool-shared-externals';
import { NFError } from 'lib/core/native-federation.error';
import { mockAdapters } from 'lib/testing/adapters.mock';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import {
  GLOBAL_SCOPE,
  type SharedExternal,
  type SharedVersion,
  type SharedVersionMeta,
} from 'lib/core/1.domain';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { tagStoredByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';

type MetaOpt = {
  req?: string;
  strict?: boolean;
  cached?: boolean;
  pool?: string;
  file?: string;
};

const meta = (name: string, o: MetaOpt = {}): SharedVersionMeta =>
  mockVersionRemote(name, 'ext', {
    requiredVersion: o.req ?? '17',
    strictVersion: o.strict ?? true,
    cached: o.cached ?? false,
    pool: o.pool,
    file: o.file,
  });

const sharedVersion = (
  tag: string,
  remotes: SharedVersionMeta[],
  o: { host?: boolean; action?: SharedVersion['action'] } = {}
): SharedVersion => ({ tag, host: o.host ?? false, action: o.action ?? 'skip', remotes });

const external = (versions: SharedVersion[], dirty = false): SharedExternal => ({
  dirty,
  versions,
});

describe('createPoolSharedExternals', () => {
  let poolSharedExternals: ForPoolingSharedExternals;
  let config: ConfigContract;
  let adapters: DrivingContract;
  // Stands in for the build's default tag: every untagged scoped package is tagged with its npm scope,
  // which is what `useAutoExternalPooling` used to do at runtime.
  let autoTag: boolean;
  // A deep copy of what `givenExternals` seeded, so a test can compare the stored outcome against it.
  let seeded: Record<string, SharedExternal>;

  beforeEach(() => {
    autoTag = false;
    seeded = {};
    config = mockConfig();
    adapters = mockAdapters();
    adapters.sharedExternalsRepo.getScopes = vi.fn(() => [GLOBAL_SCOPE]);
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'global' as const);
    adapters.versionCheck = createVersionCheck();

    poolSharedExternals = createPoolSharedExternals(config, adapters);
  });

  // `meta()` cannot know which member it is being seeded under, so it keys every entrypoint on the same
  // placeholder specifier. Coverage is keyed by specifier, so left alone every member of every fixture
  // would cover every other one — vacuously. Re-keying here is what gives each member its own specifier,
  // exactly as a real remote entry does. A fixture that seeded entries deliberately keeps them.
  const givenExternals = (externals: Record<string, SharedExternal>) => {
    for (const [name, external] of Object.entries(externals)) {
      for (const version of external.versions) {
        for (const remote of version.remotes) {
          if (!('ext' in remote.entries)) continue;
          remote.entries = { [name]: remote.entries['ext']! };
        }
      }
    }
    if (autoTag) tagStoredByNpmScope(externals);
    seeded = structuredClone(externals);
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => externals);
  };

  const writes = () => vi.mocked(adapters.sharedExternalsRepo.addOrUpdate).mock.calls;

  // What storage holds for `name` once the step ran: the last write wins, as in the real repo.
  const writtenFor = (name: string): SharedExternal | undefined =>
    writes()
      .filter(c => c[0] === name)
      .at(-1)?.[1];

  const causeOf = (external: SharedExternal, remote: string) =>
    external.versions.flatMap(v => v.remotes).find(r => r.name === remote)?.poolCause;

  // Every verdict the written record ends up holding: a scoped copy's `poolCause` and a subpool copy's
  // `servedBy`. Islands are read from here, not from the warnings (D4 in plan.md).
  const verdictsWritten = (): string[] =>
    [...new Set(writes().map(c => c[0]))]
      .flatMap(name =>
        writtenFor(name)!
          .versions.flatMap(v => v.remotes)
          .flatMap(r => [
            ...(r.poolCause ? [`${r.name}@${name}: ${r.poolCause}`] : []),
            ...(r.servedBy ? [`${r.name}@${name}: served by ${r.servedBy}`] : []),
          ])
      )
      .sort();

  const namesOf = (external: SharedExternal, action: SharedVersion['action']): string[] =>
    external.versions
      .filter(v => v.action === action)
      .flatMap(v => v.remotes.map(r => r.name))
      .sort();

  const servedByOf = (external: SharedExternal): Record<string, string> =>
    Object.fromEntries(
      external.versions
        .flatMap(v => v.remotes)
        .filter(r => r.servedBy !== undefined)
        .map(r => [r.name, r.servedBy!])
    );

  // a's build serves the majority (core + common). c and d agree on core but lack common, and ship cdk at
  // two tags their strict ranges keep apart.
  const coverageMiss = (): Record<string, SharedExternal> => ({
    '@framework/core': external([
      sharedVersion('17.0.0', [
        meta('a', { req: '^17.0.0' }),
        meta('b', { req: '^17.0.0' }),
        meta('c', { req: '^17.0.0' }),
        meta('d', { req: '^17.0.0' }),
      ]),
    ]),
    '@framework/common': external([
      sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('b', { req: '^17.0.0' })]),
    ]),
    '@framework/cdk': external([
      sharedVersion('17.1.0', [meta('d', { req: '~17.1.0' })]),
      sharedVersion('17.0.0', [meta('c', { req: '~17.0.0' })]),
    ]),
  });

  describe('when inert', () => {
    it('does nothing when pooling is disabled and no pool tags are present', async () => {
      givenExternals({
        '@framework/core': external([sharedVersion('17.0.0', [meta('mfe1')], { action: 'share' })]),
        '@framework/common': external([
          sharedVersion('17.0.0', [meta('mfe1')], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('rebuilds a single-remote pool already stored as elected unchanged', async () => {
      autoTag = true;
      givenExternals({
        '@framework/core': {
          ...external([sharedVersion('17.0.0', [meta('mfe1')], { action: 'share' })]),
          poolName: 'framework',
          poolWinner: 'mfe1',
        },
        '@framework/common': {
          ...external([sharedVersion('17.0.0', [meta('mfe1')], { action: 'share' })]),
          poolName: 'framework',
          poolWinner: 'mfe1',
        },
      });

      await poolSharedExternals();

      // The stored name is already right, so the name sync writes nothing: a write here is the election
      // rebuilding the pool (it was marked dirty), and it lands on exactly what storage already held.
      for (const [name, stored] of Object.entries(seeded)) expect(writtenFor(name)).toEqual(stored);
    });

    it('is a no-op for a single-member pool', async () => {
      autoTag = true;
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('mfe1')], { action: 'share' }),
          sharedVersion('18.0.0', [meta('mfe2', { req: '18' })]),
        ]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('skips the strict scope entirely', async () => {
      autoTag = true;
      adapters.sharedExternalsRepo.getScopes = vi.fn(() => ['strict']);
      adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'strict' as const);

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });
  });

  // Performance contracts: W1, a scope carrying no pool state builds no pool graph; W2, a pool none of
  // whose members was re-elected (a warm init) is not elected again. Each skip has a control beside it
  // proving the skip is selective.
  describe('skips work', () => {
    const taggedPair = () =>
      givenExternals({
        foo: external([
          sharedVersion('17.0.0', [meta('mfe1', { pool: 'grp' }), meta('mfe2', { pool: 'grp' })], {
            action: 'share',
          }),
        ]),
        bar: external([
          sharedVersion('17.0.0', [meta('mfe1', { pool: 'grp' }), meta('mfe2', { pool: 'grp' })], {
            action: 'share',
          }),
        ]),
      });

    // W2: determine clears `dirty`, so its per-scope set of re-elected externals is the only signal for
    // what changed. This pool islands `c` on every member when elected (its core range rejects the 17 a's
    // build serves), so a stored `poolCause` on c proves the pool was elected and its absence that it was not.
    // A record a previous election wrote: `a` won it, which pooling stores as `poolWinner` and which decides
    // the tie between `a` and `c` again.
    const islandingPool = () => {
      autoTag = true;
      givenExternals({
        '@framework/core': {
          ...external([
            sharedVersion('17.0.0', [meta('a', { req: '17' })], { action: 'share' }),
            sharedVersion('18.0.0', [meta('c', { req: '18' })], { action: 'scope' }),
          ]),
          poolWinner: 'a',
        },
        '@framework/common': {
          ...external([
            sharedVersion('17.0.0', [meta('a', { req: '17' }), meta('c', { req: '17' })], {
              action: 'share',
            }),
          ]),
          poolWinner: 'a',
        },
      });
    };

    it('reads no scope that carries no pool state (W1)', async () => {
      adapters.sharedExternalsRepo.hasPoolState = vi.fn(() => false);

      await poolSharedExternals();

      // `getScopes` is names only; what must not happen is reading a scope out of storage.
      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    // The narrowing: only a scope carrying a tag (or a stored pool) is read. One tag used to make every
    // non-strict scope build a pool graph.
    it('reads only the scopes that carry pool state (W1)', async () => {
      adapters.sharedExternalsRepo.getScopes = vi.fn(() => [GLOBAL_SCOPE, 'team-a', 'team-b']);
      adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'shareScope' as const);
      adapters.sharedExternalsRepo.hasPoolState = vi.fn(scope => scope === 'team-a');
      taggedPair();

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.getFromScope).toHaveBeenCalledTimes(1);
      expect(adapters.sharedExternalsRepo.getFromScope).toHaveBeenCalledWith('team-a');
    });

    it('still pools a scope that carries pool state', async () => {
      adapters.sharedExternalsRepo.hasPoolState = vi.fn(() => true);
      taggedPair();

      await poolSharedExternals();

      expect(writtenFor('foo')!.poolName).toBe('grp');
      expect(writtenFor('bar')!.poolName).toBe('grp');
    });

    it('reads no scope with nothing re-elected (W2)', async () => {
      islandingPool();

      await poolSharedExternals(new Map([['other-scope', new Set(['@framework/core'])]]));

      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('elects no pool none of whose members was re-elected (W2)', async () => {
      islandingPool();

      await poolSharedExternals(new Map([[GLOBAL_SCOPE, new Set(['unrelated-dep'])]]));

      // Named (`syncPoolNames` runs for the whole touched scope), but every verdict stays as stored.
      for (const [name, stored] of Object.entries(seeded))
        expect(writtenFor(name)).toEqual({ ...stored, poolName: 'framework' });
      expect(verdictsWritten()).toEqual([]);
    });

    it('still re-elects the whole pool when any single member was re-elected', async () => {
      islandingPool();

      await poolSharedExternals(new Map([[GLOBAL_SCOPE, new Set(['@framework/core'])]]));

      // Both members, not just the re-elected one: islanding `c` scopes its whole family.
      expect(verdictsWritten()).toEqual([
        'c@@framework/common: incompatible',
        'c@@framework/core: incompatible',
      ]);
    });

    it('still re-elects every pool when called without a signal', async () => {
      islandingPool();

      await poolSharedExternals();

      expect(verdictsWritten()).toEqual([
        'c@@framework/common: incompatible',
        'c@@framework/core: incompatible',
      ]);
    });
  });

  describe('membership', () => {
    it('pools via an explicit remote pool tag', async () => {
      givenExternals({
        foo: external([
          sharedVersion('17.0.0', [meta('mfe1', { pool: 'grp' }), meta('mfe2', { pool: 'grp' })], {
            action: 'share',
          }),
        ]),
        bar: external([
          sharedVersion('17.0.0', [meta('mfe2', { pool: 'grp' }), meta('mfe1', { pool: 'grp' })], {
            action: 'share',
          }),
        ]),
      });

      await poolSharedExternals();

      // Both builds serve both remotes; which one wins the tie does not matter here.
      for (const name of ['foo', 'bar']) {
        expect(writtenFor(name)!.poolName).toBe('grp');
        expect(namesOf(writtenFor(name)!, 'share')).toEqual(['mfe1', 'mfe2']);
      }
    });
  });

  /**
   * The election itself, on real semver: round 1 picks the build serving the most remotes as the global one,
   * later rounds place what is left in subpools, and everyone left serves themselves. Versions on
   * `determine`'s rows are ignored — pooling elects its members (D1) — except the stored winner, which
   * breaks ties (D2).
   */
  describe('variant election', () => {
    beforeEach(() => {
      autoTag = true;
    });

    const shareOf = (name: string) => writtenFor(name)!.versions.find(v => v.action === 'share');
    const rowsOf = (name: string) =>
      writtenFor(name)!.versions.map(v => `${v.tag}:${v.action}:[${v.remotes.map(r => r.name)}]`);

    it('elects the build that serves the most remotes, even an older one', async () => {
      // a ships core + forms at 17.0.0, b only core at 17.1.0. Both ranges take either, but only a's
      // build serves both remotes, so the family runs 17.0.0 and b dedups onto it.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' })]),
        ]),
        '@framework/forms': external([sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' })])]),
      });

      await poolSharedExternals();

      expect(rowsOf('@framework/core')).toEqual(['17.1.0:skip:[b]', '17.0.0:share:[a]']);
      expect(rowsOf('@framework/forms')).toEqual(['17.0.0:share:[a]']);
      expect(verdictsWritten()).toEqual([]);
    });

    it("forces the host's build as round 1 whatever it serves", async () => {
      // b's build would serve both remotes; the host's serves only itself, and still wins.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })]),
          sharedVersion('17.0.0', [meta('host', { req: '~17.0.0' })], { host: true }),
        ]),
        '@framework/forms': external([sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })])]),
      });

      await poolSharedExternals();

      expect(shareOf('@framework/core')).toMatchObject({ tag: '17.0.0', host: true });
      expect(shareOf('@framework/core')!.remotes[0]!.name).toBe('host');
    });

    it('keeps the host flag on a re-election whose host tag also holds another row', async () => {
      // The record a previous election stored: x shares host's core@17.0.0 but its common@18 rejects the
      // elected 17, so x's copies are islanded into a `scope` row at the host's own tag. The rows of one tag
      // must not decide the host flag between them — the last one read (`scope`) would drop it, and the next
      // re-election would no longer know which build cannot be repointed.
      givenExternals({
        '@framework/core': external(
          [
            sharedVersion('17.0.0', [meta('host', { req: '~17.0.0' })], {
              host: true,
              action: 'share',
            }),
            sharedVersion('17.0.0', [meta('x', { req: '^17.0.0' })], { action: 'scope' }),
          ],
          true
        ),
        '@framework/common': external(
          [
            sharedVersion('18.0.0', [meta('x', { req: '^18.0.0' })], { action: 'scope' }),
            sharedVersion('17.0.0', [meta('host', { req: '~17.0.0' })], {
              host: true,
              action: 'share',
            }),
          ],
          true
        ),
      });

      await poolSharedExternals();

      expect(rowsOf('@framework/core')).toEqual(['17.0.0:share:[host]', '17.0.0:scope:[x]']);
      expect(writtenFor('@framework/core')!.versions.map(v => v.host)).toEqual([true, false]);
      expect(shareOf('@framework/common')).toMatchObject({ tag: '17.0.0', host: true });
    });

    // Two builds that each serve only themselves and agree with nobody; a arrives first and is newer.
    const tied = (winners: { core?: string; common?: string }) => ({
      '@framework/core': {
        ...external([
          sharedVersion('18.0.0', [meta('a', { req: '~18.0.0' })]),
          sharedVersion('17.0.0', [meta('b', { req: '~17.0.0' })], { action: 'share' }),
        ]),
        poolWinner: winners.core,
      },
      '@framework/common': {
        ...external([
          sharedVersion('18.0.0', [meta('a', { req: '~18.0.0' })]),
          sharedVersion('17.0.0', [meta('b', { req: '~17.0.0' })], { action: 'share' }),
        ]),
        poolWinner: winners.common,
      },
    });

    it('keeps the stored winner on a tie (D2)', async () => {
      // b won last time, so b keeps it, although a is the newer build.
      givenExternals(tied({ core: 'b', common: 'b' }));

      await poolSharedExternals();

      expect(shareOf('@framework/core')!.tag).toBe('17.0.0');
      expect(writtenFor('@framework/core')!.poolWinner).toBe('b');
    });

    it('ignores a stored winner the members disagree on', async () => {
      givenExternals(tied({ core: 'b', common: 'a' }));

      await poolSharedExternals();

      // No previous winner, so arrival order breaks the tie.
      expect(shareOf('@framework/core')!.tag).toBe('18.0.0');
      expect(writtenFor('@framework/common')!.poolWinner).toBe('a');
    });

    it('keeps the stored winner when a member that joined since carries none', async () => {
      givenExternals(tied({ core: 'b' }));

      await poolSharedExternals();

      expect(shareOf('@framework/core')!.tag).toBe('17.0.0');
      expect(writtenFor('@framework/common')!.poolWinner).toBe('b');
    });

    it('ignores a stored winner that ships no member any more', async () => {
      givenExternals(tied({ core: 'gone', common: 'gone' }));

      await poolSharedExternals();

      expect(shareOf('@framework/core')!.tag).toBe('18.0.0');
      expect(writtenFor('@framework/core')!.poolWinner).toBe('a');
    });

    it('takes the newest build first under latestSharedExternal (D3)', async () => {
      config.profile.latestSharedExternal = true;
      // a's 17.9.0 build serves both remotes, b's 17.10.0 only b; the flag puts the newest first anyway.
      // Newest by semver: compared as strings, 17.9.0 would sort above 17.10.0.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.10.0', [meta('b', { req: '^17.0.0' })]),
          sharedVersion('17.9.0', [meta('a', { req: '^17.0.0' })]),
        ]),
        '@framework/forms': external([sharedVersion('17.9.0', [meta('a', { req: '^17.0.0' })])]),
      });

      await poolSharedExternals();

      expect(shareOf('@framework/core')!.tag).toBe('17.10.0');
      // a cannot take b's build (b ships no forms), so it serves its own family.
      expect(verdictsWritten()).toEqual([
        'a@@framework/core: uncovered',
        'a@@framework/forms: uncovered',
      ]);
    });

    describe('which build is newer', () => {
      // x runs core@17.10 with zz@9, y runs core@17.9 with zz@99. The highest tag either ships is y's zz@99,
      // but that line has nothing to do with core's: builds compare member by member, and core (first by
      // name) decides — x is newer by semver, though '17.9.0' sorts above '17.10.0' as a string. Tilde
      // ranges keep each build serving only itself.
      const portfolio = () => ({
        '@framework/core': external([
          sharedVersion('17.10.0', [meta('x', { req: '~17.10.0' })]),
          sharedVersion('17.9.0', [meta('y', { req: '~17.9.0' })]),
        ]),
        '@framework/zz': external([
          sharedVersion('99.0.0', [meta('y', { req: '~99.0.0' })]),
          sharedVersion('9.0.0', [meta('x', { req: '~9.0.0' })]),
        ]),
      });

      it('breaks the last tie by the first member whose tags differ, never across lines', async () => {
        givenExternals(portfolio());

        await poolSharedExternals();

        expect(shareOf('@framework/core')!.remotes[0]!.name).toBe('x');
      });

      it('puts the newer build first under latestSharedExternal (D3), compared the same way', async () => {
        config.profile.latestSharedExternal = true;
        const externals = portfolio();
        // y now serves a second remote, which would win it round 1 without the flag.
        externals['@framework/core']!.versions[1]!.remotes.push(meta('w', { req: '~17.9.0' }));
        givenExternals(externals);

        await poolSharedExternals();

        expect(shareOf('@framework/core')!.remotes[0]!.name).toBe('x');
      });
    });

    it('breaks a tie on served remotes toward the build more remotes agree with', async () => {
      // Every build serves only itself. a and b agree on core@17; c runs 18. Newest-first would elect c
      // and island both 17 remotes; agreement elects a 17 build, which a and b then share.
      givenExternals({
        '@framework/core': external([
          sharedVersion('18.0.0', [meta('c', { req: '^18.0.0' })]),
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('b', { req: '^17.0.0' })]),
        ]),
        '@framework/common': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('c', { req: '^17.0.0' })]),
        ]),
        '@framework/cdk': external([sharedVersion('17.0.0', [meta('b', { req: '^17.0.0' })])]),
      });

      await poolSharedExternals();

      expect(shareOf('@framework/core')!.tag).toBe('17.0.0');
      expect(namesOf(writtenFor('@framework/core')!, 'scope')).toEqual(['c']);
    });

    it('places what round 1 left in a subpool running one build, through scopes', async () => {
      // Two 21 remotes beside a 22 majority: legacy-a's build serves legacy-b (~21.2.0 takes 21.2.18).
      givenExternals({
        '@framework/core': external([
          sharedVersion('22.0.8', [meta('a', { req: '^22.0.0' }), meta('b', { req: '^22.0.0' })]),
          sharedVersion('21.2.18', [meta('legacy-a', { req: '~21.2.0' })]),
          sharedVersion('21.2.15', [meta('legacy-b', { req: '~21.2.0' })]),
        ]),
        '@framework/router': external([
          sharedVersion('22.0.8', [meta('a', { req: '^22.0.0' })]),
          sharedVersion('21.2.18', [meta('legacy-a', { req: '~21.2.0' })]),
        ]),
      });

      await poolSharedExternals();

      // The subpool's build names itself so its own scope maps its family; its members name the build.
      // Neither is scoped: a subpool copy carries `servedBy`, never a `poolCause`.
      expect(namesOf(writtenFor('@framework/core')!, 'scope')).toEqual([]);
      expect(verdictsWritten()).toEqual([
        'legacy-a@@framework/core: served by legacy-a',
        'legacy-a@@framework/router: served by legacy-a',
        'legacy-b@@framework/core: served by legacy-a',
      ]);
    });

    it('forms no subpool of one: a lone remote serves itself', async () => {
      givenExternals({
        '@framework/core': external([
          sharedVersion('22.0.8', [meta('a', { req: '^22.0.0' }), meta('b', { req: '^22.0.0' })]),
          sharedVersion('21.2.18', [meta('legacy', { req: '~21.2.0' })]),
        ]),
        '@framework/router': external([
          sharedVersion('22.0.8', [meta('a', { req: '^22.0.0' })]),
          sharedVersion('21.2.18', [meta('legacy', { req: '~21.2.0' })]),
        ]),
      });

      await poolSharedExternals();

      expect(namesOf(writtenFor('@framework/core')!, 'scope')).toEqual(['legacy']);
      expect(namesOf(writtenFor('@framework/router')!, 'scope')).toEqual(['legacy']);
      expect(verdictsWritten()).toEqual([
        'legacy@@framework/core: incompatible',
        'legacy@@framework/router: incompatible',
      ]);
    });

    it('never lets a disagreeing remote take a same-version global file', async () => {
      // c runs core@18 and common@17 — the elected common's tag. Taking the global common file would bind
      // it to the global core@17 one import in, beside c's own core@18: two cores in c.
      givenExternals({
        '@framework/core': external([
          sharedVersion('18.0.0', [meta('c', { req: '^18.0.0' })]),
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('b', { req: '^17.0.0' })]),
        ]),
        '@framework/common': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('c', { req: '^17.0.0' })]),
        ]),
      });

      await poolSharedExternals();

      expect(namesOf(writtenFor('@framework/common')!, 'scope')).toEqual(['c']);
      expect(namesOf(writtenFor('@framework/common')!, 'share')).toEqual(['a']);
    });

    it('lets an agreeing remote take the elected files and serve only the rest itself', async () => {
      // b and c agree with a on core@17 but ship cdk at two different tags, so cdk cannot be published for
      // both: each runs its own cdk and takes the global core.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [
            meta('a', { req: '^17.0.0' }),
            meta('b', { req: '^17.0.0' }),
            meta('c', { req: '^17.0.0' }),
          ]),
        ]),
        '@framework/common': external([sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' })])]),
        '@framework/cdk': external([
          sharedVersion('17.1.0', [meta('b', { req: '~17.1.0' })]),
          sharedVersion('17.0.0', [meta('c', { req: '~17.0.0' })]),
        ]),
      });

      await poolSharedExternals();

      expect(namesOf(writtenFor('@framework/core')!, 'share')).toEqual(['a', 'b', 'c']);
      expect(namesOf(writtenFor('@framework/cdk')!, 'scope')).toEqual(['b', 'c']);
      expect(verdictsWritten()).toEqual([
        'b@@framework/cdk: uncovered',
        'c@@framework/cdk: uncovered',
      ]);
    });

    it('shares a package the winner ships only as secondary entrypoints', async () => {
      // `@framework/material` is declared with `/table` alone — no root entry — so round 1 serves the package
      // through its entrypoint, and the record still has to say which copy is shared.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('b', { req: '^17.0.0' })]),
        ]),
        '@framework/material': external([
          sharedVersion('17.0.0', [
            mockVersionRemote('a', '@framework/material', {
              requiredVersion: '^17.0.0',
              entries: { '@framework/material/table': 'table.js' },
            }),
          ]),
        ]),
      });

      await poolSharedExternals();

      expect(rowsOf('@framework/material')).toEqual(['17.0.0:share:[a]']);
    });

    describe('a package shipped only as secondary entrypoints', () => {
      const material = '@framework/material';
      const copy = (remote: string, tag: string, entrypoint: string) =>
        sharedVersion(tag, [
          mockVersionRemote(remote, material, {
            requiredVersion: '^17.0.0',
            entries: { [`${material}/${entrypoint}`]: `${entrypoint}.js` },
          }),
        ]);
      const core = () =>
        external([
          sharedVersion('17.0.0', [
            meta('a', { req: '^17.0.0' }),
            meta('b', { req: '^17.0.0' }),
            meta('c', { req: '^17.0.0' }),
          ]),
        ]);

      it('pins an entrypoint nobody published by its siblings, so the package keeps one tag', async () => {
        // b and c ship `/sort` at 17.0.2 and win round 1. a ships only `/table`, at 17.0.0. Neither build
        // lists the package root, so `/table` is pinned by `/sort`'s tag: a disagrees, and its 17.0.0 table
        // must not be published beside the elected 17.0.2 sort — two Material builds in one map.
        givenExternals({
          '@framework/core': core(),
          [material]: external([
            sharedVersion('17.0.2', [
              mockVersionRemote('b', material, {
                requiredVersion: '^17.0.0',
                entries: { [`${material}/sort`]: 'sort.js' },
              }),
              mockVersionRemote('c', material, {
                requiredVersion: '^17.0.0',
                entries: { [`${material}/sort`]: 'sort.js' },
              }),
            ]),
            copy('a', '17.0.0', 'table'),
          ]),
        });

        await poolSharedExternals();

        expect(rowsOf(material)).toEqual(['17.0.2:share:[b,c]', '17.0.0:scope:[a]']);
        expect(verdictsWritten()).toEqual([
          'a@@framework/core: uncovered',
          'a@@framework/material: uncovered',
        ]);
      });

      it('publishes a sibling entrypoint shipped at the elected tag', async () => {
        // Same shape, but a's `/table` is at the elected 17.0.2: one Material build, so it is served
        // globally.
        givenExternals({
          '@framework/core': core(),
          [material]: external([
            sharedVersion('17.0.2', [
              mockVersionRemote('b', material, {
                requiredVersion: '^17.0.0',
                entries: { [`${material}/sort`]: 'sort.js' },
              }),
              mockVersionRemote('c', material, {
                requiredVersion: '^17.0.0',
                entries: { [`${material}/sort`]: 'sort.js' },
              }),
              mockVersionRemote('a', material, {
                requiredVersion: '^17.0.0',
                entries: { [`${material}/table`]: 'table.js' },
              }),
            ]),
          ]),
        });

        await poolSharedExternals();

        // Every build borrows the other entrypoint at the same tag in round 1, so all three serve everyone
        // and which copy leads the row is only the tiebreak; one row is the point.
        expect(writtenFor(material)!.versions).toHaveLength(1);
        expect(namesOf(writtenFor(material)!, 'share')).toEqual(['a', 'b', 'c']);
        expect(verdictsWritten()).toEqual([]);
      });
    });

    it('keeps a build round 1 borrows an entrypoint from on a route that publishes it', async () => {
      // b agrees with w's core@1.1 and is the only build shipping core/testing@1.1, which round 1 borrows to
      // serve r (core@1.0 + testing, ^1). b misses round 1 (it needs p, which w lacks). In a's subpool
      // (core@1.2, disagreeing), b's copy would be servedBy a and nothing would publish core/testing@1.1: r
      // would self-fill a 1.0 testing next to the global 1.1 core. The subpool runs b's build instead (a and
      // b), agreeing, so the extension publishes p from it — and then serves both a and b, whose ^1 takes the
      // global 1.1: the subpool dissolves into round 1 and b's testing is shared.
      const core = '@framework/core';
      const testing = '@framework/core/testing';
      const copy = (remote: string, member: string, entries: string[]) =>
        mockVersionRemote(remote, member, {
          requiredVersion: '^1.0.0',
          entries: Object.fromEntries(entries.map(e => [e, `${e}.js`])),
        });
      givenExternals({
        [core]: external([
          sharedVersion('1.2.0', [copy('a', core, [core, testing])]),
          sharedVersion('1.1.0', [
            copy('w', core, [core]),
            copy('w2', core, [core]),
            copy('w3', core, [core]),
            copy('w4', core, [core]),
            copy('b', core, [core, testing]),
          ]),
          sharedVersion('1.0.0', [copy('r', core, [core, testing])]),
        ]),
        '@framework/q': external([
          sharedVersion('1.0.0', [
            copy('w', '@framework/q', ['@framework/q']),
            copy('w2', '@framework/q', ['@framework/q']),
            copy('w3', '@framework/q', ['@framework/q']),
            copy('w4', '@framework/q', ['@framework/q']),
          ]),
        ]),
        '@framework/p': external([
          sharedVersion('1.0.0', [
            copy('a', '@framework/p', ['@framework/p']),
            copy('b', '@framework/p', ['@framework/p']),
          ]),
        ]),
      });

      await poolSharedExternals();

      expect(rowsOf(core)).toEqual([
        '1.2.0:skip:[a]',
        '1.1.0:share:[w,w2,w3,w4,b]',
        '1.0.0:skip:[r]',
      ]);
      expect(verdictsWritten()).toEqual([]);
    });

    describe('a subpool the extension serves', () => {
      // w, w2 and w3 elect core + forms. a and r ship core + animations instead, so a later round places r in
      // a's subpool; both agree with round 1 and ship animations at one tag, so the extension then publishes
      // it.
      const portfolio = (): Record<string, SharedExternal> => ({
        '@framework/core': external([
          sharedVersion('17.0.0', [
            meta('w', { req: '^17.0.0' }),
            meta('w2', { req: '^17.0.0' }),
            meta('w3', { req: '^17.0.0' }),
            meta('a', { req: '^17.0.0' }),
            meta('r', { req: '^17.0.0' }),
          ]),
        ]),
        '@framework/forms': external([
          sharedVersion('17.0.0', [
            meta('w', { req: '^17.0.0' }),
            meta('w2', { req: '^17.0.0' }),
            meta('w3', { req: '^17.0.0' }),
          ]),
        ]),
        '@framework/animations': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('r', { req: '^17.0.0' })]),
        ]),
      });

      it('moves the whole subpool onto the global map, with nothing to warn', async () => {
        givenExternals(portfolio());

        await poolSharedExternals();

        expect(rowsOf('@framework/animations')).toEqual(['17.0.0:share:[a,r]']);
        expect(verdictsWritten()).toEqual([]);
        expect(config.log.warn).not.toHaveBeenCalled();
      });

      it('dissolves a subpool the extension leaves with its build alone', async () => {
        // a also ships cdk@17.1.0, c ships cdk@17.0.0 and their ranges keep them apart, so cdk is not
        // published: r moves global, a cannot, and a subpool of one is none.
        const externals = portfolio();
        externals['@framework/cdk'] = external([
          sharedVersion('17.1.0', [meta('a', { req: '~17.1.0' })]),
          sharedVersion('17.0.0', [meta('c', { req: '~17.0.0' })]),
        ]);
        externals['@framework/core']!.versions[0]!.remotes.push(meta('c', { req: '^17.0.0' }));
        givenExternals(externals);

        await poolSharedExternals();

        expect(rowsOf('@framework/animations')).toEqual(['17.0.0:share:[a,r]']);
        expect(namesOf(writtenFor('@framework/cdk')!, 'scope')).toEqual(['a', 'c']);
        expect(verdictsWritten()).toEqual([
          'a@@framework/cdk: uncovered',
          'c@@framework/cdk: uncovered',
        ]);
      });

      it('keeps a subpool whose build the extension serves while another member still needs it', async () => {
        // x (core@17.0.0, ~17.0.0) is the only agreeing contributor and gets animations@17.0.0 published.
        // a runs core@17.1.0 with ^17, r pins ~17.1.0: a later round places r in a's subpool. After the
        // extension the global map would serve a (its ^17 takes 17.0.0) but not r, so the subpool moves only
        // as a whole —
        // it stays, and a is told why it runs its own build though nothing rejects or lacks.
        givenExternals({
          '@framework/core': external([
            sharedVersion('17.1.0', [meta('a', { req: '^17.0.0' }), meta('r', { req: '~17.1.0' })]),
            sharedVersion('17.0.0', [
              meta('w', { req: '^17.0.0' }),
              meta('w2', { req: '^17.0.0' }),
              meta('w3', { req: '^17.0.0' }),
              meta('x', { req: '~17.0.0' }),
            ]),
          ]),
          '@framework/forms': external([
            sharedVersion('17.0.0', [
              meta('w', { req: '^17.0.0' }),
              meta('w2', { req: '^17.0.0' }),
              meta('w3', { req: '^17.0.0' }),
            ]),
          ]),
          '@framework/animations': external([
            sharedVersion('17.0.0', [
              meta('x', { req: '^17.0.0' }),
              meta('a', { req: '^17.0.0' }),
              meta('r', { req: '^17.0.0' }),
            ]),
          ]),
        });

        await poolSharedExternals();

        expect(verdictsWritten()).toEqual([
          'a@@framework/animations: served by a',
          'a@@framework/core: served by a',
          'r@@framework/animations: served by a',
          'r@@framework/core: served by a',
        ]);
        // a stays on its own core although the elected build would serve it: r still needs a's build.
        expect(rowsOf('@framework/core')).toEqual([
          '17.1.0:skip:[a,r]',
          '17.0.0:share:[w,w2,w3,x]',
        ]);
      });
    });

    it('publishes a package the winner lacks when every agreeing remote ships it at one tag', async () => {
      // Ragged: a ships core + common, b common + forms, all 17. a's build cannot serve b (no forms), but
      // b agrees with it and is the only forms provider, so forms is published from b and b runs globally.
      givenExternals({
        '@framework/core': external([sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' })])]),
        '@framework/common': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('b', { req: '^17.0.0' })]),
        ]),
        '@framework/forms': external([sharedVersion('17.0.0', [meta('b', { req: '^17.0.0' })])]),
      });

      await poolSharedExternals();

      expect(rowsOf('@framework/forms')).toEqual(['17.0.0:share:[b]']);
      expect(rowsOf('@framework/common')).toEqual(['17.0.0:share:[a,b]']);
      expect(verdictsWritten()).toEqual([]);
    });
  });

  // D4: strictExternalCompatibility refuses a range that rejects the elected build, never a coverage miss.
  describe('strict compatibility', () => {
    beforeEach(() => {
      autoTag = true;
      config.strict.strictExternalCompatibility = true;
      poolSharedExternals = createPoolSharedExternals(config, adapters);
    });

    it('throws when a strict range rejects the elected build', async () => {
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('b', { req: '^17.0.0' })]),
          sharedVersion('18.0.0', [meta('c', { req: '^18.0.0', strict: true })]),
        ]),
        '@framework/common': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('c', { req: '^17.0.0' })]),
        ]),
      });

      await expect(poolSharedExternals()).rejects.toThrow(NFError);
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('does not throw when the rejecting range is not strict', async () => {
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('b', { req: '^17.0.0' })]),
          sharedVersion('18.0.0', [meta('c', { req: '^18.0.0', strict: false })]),
        ]),
        '@framework/common': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('c', { req: '^17.0.0' })]),
        ]),
      });

      await expect(poolSharedExternals()).resolves.toBeUndefined();
    });

    it('throws when any rejecting copy is strict, whichever member is read first', async () => {
      // c rejects the elected 17 on both members, but only its core range is strict. common comes first in
      // the pool, so judging only c's first rejection would read a non-strict one and island c silently.
      givenExternals({
        '@framework/common': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('b', { req: '^17.0.0' })]),
          sharedVersion('18.0.0', [meta('c', { req: '^18.0.0', strict: false })]),
        ]),
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('b', { req: '^17.0.0' })]),
          sharedVersion('18.0.0', [meta('c', { req: '^18.0.0', strict: true })]),
        ]),
      });

      await expect(poolSharedExternals()).rejects.toThrow(NFError);
      expect(config.log.error).toHaveBeenCalledWith(3, expect.stringContaining('{c}'));
    });

    it('does not throw when a remote misses round 1 for lack of coverage', async () => {
      // a's build serves the common-consuming majority. c and d agree with it but ship cdk at two tags their
      // ranges keep apart, so cdk is not published and neither serves the other: a coverage miss for both,
      // nothing to refuse.
      givenExternals(coverageMiss());

      await expect(poolSharedExternals()).resolves.toBeUndefined();
      expect(verdictsWritten()).toEqual([
        'c@@framework/cdk: uncovered',
        'd@@framework/cdk: uncovered',
      ]);
    });
  });

  // What pooling stores for tools to read: the pool an external is in (`SharedExternal.poolName`) and, per
  // scoped copy, why it self-serves (`poolCause`). See docs/version-resolver.md §"What pooling stores".
  describe('stored pool state', () => {
    // mfe3 is islanded on core@18 and ships the matching common@17 too; mfe2 makes 17 the majority.
    const islanding = () => ({
      '@framework/core': external([
        sharedVersion(
          '17.0.0',
          [meta('mfe1', { req: '^17.0.0' }), meta('mfe2', { req: '^17.0.0' })],
          {
            action: 'share',
          }
        ),
        sharedVersion('18.0.0', [meta('mfe3', { req: '^18.0.0' })], { action: 'scope' }),
      ]),
      '@framework/common': external([
        sharedVersion(
          '17.0.0',
          [meta('mfe1', { req: '^17.0.0' }), meta('mfe3', { req: '^17.0.0' })],
          {
            action: 'share',
          }
        ),
      ]),
    });

    beforeEach(() => {
      autoTag = true;
    });

    it('writes the pool name and round-1 winner onto every rebuilt member', async () => {
      adapters.versionCheck = createVersionCheck();
      poolSharedExternals = createPoolSharedExternals(config, adapters);
      givenExternals(islanding());

      await poolSharedExternals();

      expect(writtenFor('@framework/core')!.poolName).toBe('framework');
      expect(writtenFor('@framework/common')!.poolName).toBe('framework');
      expect(writtenFor('@framework/core')!.poolWinner).toBe('mfe1');
      expect(writtenFor('@framework/common')!.poolWinner).toBe('mfe1');
    });

    it("marks every copy of an islanded remote 'incompatible', and no clean copy", async () => {
      givenExternals(islanding());

      await poolSharedExternals();

      // Including common@17, which matched the winner: it is scoped because of core, not itself.
      expect(causeOf(writtenFor('@framework/core')!, 'mfe3')).toBe('incompatible');
      expect(causeOf(writtenFor('@framework/common')!, 'mfe3')).toBe('incompatible');
      expect(causeOf(writtenFor('@framework/core')!, 'mfe1')).toBeUndefined();
      expect(causeOf(writtenFor('@framework/common')!, 'mfe1')).toBeUndefined();
    });

    it("marks a remote that misses round 1 for lack of coverage 'uncovered'", async () => {
      givenExternals(coverageMiss());

      await poolSharedExternals();

      expect(causeOf(writtenFor('@framework/cdk')!, 'c')).toBe('uncovered');
      // Its core is the elected tag and it agrees, so that copy resolves globally with no cause.
      expect(causeOf(writtenFor('@framework/core')!, 'c')).toBeUndefined();
    });

    it('clears a stale poolCause on a re-election that otherwise needs nothing', async () => {
      // A healthy pool would take the no-op path, but the record still says mfe2 self-served last time.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('mfe1'), { ...meta('mfe2'), poolCause: 'uncovered' }], {
            action: 'share',
          }),
        ]),
        '@framework/common': external([
          sharedVersion('17.0.0', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      expect(causeOf(writtenFor('@framework/core')!, 'mfe2')).toBeUndefined();
      expect(namesOf(writtenFor('@framework/core')!, 'share')).toEqual(['mfe1', 'mfe2']);
    });

    it('clears a stale subpool and poolCause off a pool that shrank to one remote', async () => {
      // H redeployed without the family, so only R is left. R's copies still carry the verdicts the
      // two-remote pool gave them: H's subpool (whose files are gone) and an island cause.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [{ ...meta('R'), servedBy: 'H' }], { action: 'share' }),
        ]),
        '@framework/common': external([
          sharedVersion('17.0.0', [{ ...meta('R'), poolCause: 'uncovered' }], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      const core = writtenFor('@framework/core')!;
      const common = writtenFor('@framework/common')!;
      expect(servedByOf(core)).toEqual({});
      expect(causeOf(common, 'R')).toBeUndefined();
      expect(namesOf(core, 'share')).toEqual(['R']);
      expect(namesOf(common, 'share')).toEqual(['R']);
      expect(core.poolName).toBe('framework');
    });

    it('writes a healthy re-election back exactly as stored', async () => {
      givenExternals({
        '@framework/core': {
          ...external([sharedVersion('17.0.0', [meta('mfe1'), meta('mfe2')], { action: 'share' })]),
          poolName: 'framework',
          poolWinner: 'mfe1',
        },
        '@framework/common': {
          ...external([sharedVersion('17.0.0', [meta('mfe1'), meta('mfe2')], { action: 'share' })]),
          poolName: 'framework',
          poolWinner: 'mfe1',
        },
      });

      await poolSharedExternals();

      // The stored name is already right, so every write is the election's rebuild, one per member.
      expect(
        writes()
          .map(c => c[0])
          .sort()
      ).toEqual(['@framework/common', '@framework/core']);
      for (const [name, stored] of Object.entries(seeded)) expect(writtenFor(name)).toEqual(stored);
    });

    it('renames an untouched pool whose stored name differs, without rebuilding it', async () => {
      const externals: Record<string, SharedExternal> = islanding();
      for (const stored of Object.values(externals)) {
        stored.poolName = 'old-name';
        stored.poolWinner = 'mfe1';
      }
      givenExternals(externals);

      // The scope is touched, the pool is not: its verdicts stand, only the name is brought up to date.
      await poolSharedExternals(new Map([[GLOBAL_SCOPE, new Set(['unrelated-dep'])]]));

      // A rebuild would island mfe3 (its ^18 rejects the elected 17); the stored record still does not. The
      // stored poolWinner rides along: a rename is no election.
      expect(
        writes()
          .map(c => c[0])
          .sort()
      ).toEqual(['@framework/common', '@framework/core']);
      for (const [name, stored] of Object.entries(seeded))
        expect(writtenFor(name)).toEqual({ ...stored, poolName: 'framework' });
      expect(verdictsWritten()).toEqual([]);
    });

    it('clears pool and poolCause off an external that is in no pool any more', async () => {
      // `lonely` was pooled by an earlier portfolio; nothing tags it now (unscoped, so no scope tag).
      const lonely: SharedExternal = {
        ...external([
          sharedVersion('1.0.0', [{ ...meta('mfe1', { req: '1' }), poolCause: 'incompatible' }], {
            action: 'scope',
          }),
        ]),
        poolName: 'framework',
        poolWinner: 'mfe1',
      };
      givenExternals({ ...islanding(), lonely });

      await poolSharedExternals();

      const written = writtenFor('lonely');
      expect(written).toBeDefined();
      expect(written!.poolName).toBeUndefined();
      expect(written!.poolWinner).toBeUndefined();
      expect(causeOf(written!, 'mfe1')).toBeUndefined();
    });
  });
});
