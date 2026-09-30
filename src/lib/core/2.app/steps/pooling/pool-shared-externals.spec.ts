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
  // What `givenExternals` seeded, by name: a write of the same object is a name-only write
  // (`syncPoolNames`), a new object is a rebuilt verdict.
  let seeded: Record<string, SharedExternal>;

  beforeEach(() => {
    autoTag = false;
    seeded = {};
    config = mockConfig();
    adapters = mockAdapters();
    adapters.sharedExternalsRepo.getScopes = vi.fn(() => [GLOBAL_SCOPE]);
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'global' as const);
    adapters.versionCheck.isCompatible = vi.fn(() => true);
    adapters.versionCheck.compare = vi.fn((a, b) => a.localeCompare(b));

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
    seeded = { ...externals };
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => externals);
  };

  const writes = () => vi.mocked(adapters.sharedExternalsRepo.addOrUpdate).mock.calls;
  // A name-only write keeps the seeded `versions` array; a rebuild always emits a fresh one.
  const rebuilds = () => writes().filter(c => c[1].versions !== seeded[c[0]]?.versions);
  const nameWrites = () => writes().filter(c => c[1].versions === seeded[c[0]]?.versions);

  const rebuiltFor = (name: string): SharedExternal | undefined =>
    rebuilds().find(c => c[0] === name)?.[1];

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

  // A pool that islands nobody writes nothing (W1), so the debug line is what proves it was formed.
  const expectPooled = (poolName: string) =>
    expect(config.log.debug).toHaveBeenCalledWith(3, expect.stringContaining(`pool:${poolName}`));

  describe('when inert', () => {
    it('does nothing when pooling is disabled and no pool tags are present', async () => {
      givenExternals({
        '@framework/core': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
        '@framework/common': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('is a no-op for a single-remote pool', async () => {
      autoTag = true;
      givenExternals({
        '@framework/core': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
        '@framework/common': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
      });

      await poolSharedExternals();

      // Still a pool, so it is named; no verdict is rewritten.
      expect(rebuilds()).toEqual([]);
    });

    it('is a no-op for a single-member pool', async () => {
      autoTag = true;
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1')], { action: 'share' }),
          sharedVersion('18', [meta('mfe2', { req: '18' })]),
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

  describe('has-pool early-out', () => {
    it('skips the scope walk entirely when the scope carries no pool state', async () => {
      adapters.sharedExternalsRepo.hasPoolState = vi.fn(() => false);

      await poolSharedExternals();

      // `getScopes` is names only; what must not happen is reading a scope out of storage.
      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    // The narrowing: only a scope carrying a tag (or a stored pool) is read. One tag used to make every
    // non-strict scope build a pool graph.
    it('reads only the scopes that carry pool state', async () => {
      adapters.sharedExternalsRepo.getScopes = vi.fn(() => [GLOBAL_SCOPE, 'team-a', 'team-b']);
      adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'shareScope' as const);
      adapters.sharedExternalsRepo.hasPoolState = vi.fn(scope => scope === 'team-a');
      givenExternals({
        foo: external([
          sharedVersion('17', [meta('mfe1', { pool: 'grp' }), meta('mfe2', { pool: 'grp' })], {
            action: 'share',
          }),
        ]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.getFromScope).toHaveBeenCalledTimes(1);
      expect(adapters.sharedExternalsRepo.getFromScope).toHaveBeenCalledWith('team-a');
    });

    it('pools a scope that carries pool state', async () => {
      adapters.sharedExternalsRepo.hasPoolState = vi.fn(() => true);
      givenExternals({
        foo: external([
          sharedVersion('17', [meta('mfe1', { pool: 'grp' }), meta('mfe2', { pool: 'grp' })], {
            action: 'share',
          }),
        ]),
        bar: external([
          sharedVersion('17', [meta('mfe1', { pool: 'grp' }), meta('mfe2', { pool: 'grp' })], {
            action: 'share',
          }),
        ]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.getFromScope).toHaveBeenCalled();
      expectPooled('grp');
    });
  });

  // W2: determine clears `dirty`, so its per-scope set of re-elected externals is the only signal
  // for what changed. A pool nothing touched resolves to what storage already holds.
  describe('touched-externals gate', () => {
    // Would island `c` on every member, so any write at all proves the pool was processed.
    const islandingPool = () =>
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a', { req: '17' })], { action: 'share' }),
          sharedVersion('18', [meta('c', { req: '18' })], { action: 'scope' }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('a', { req: '17' }), meta('c', { req: '17' })], {
            action: 'share',
          }),
        ]),
      });

    beforeEach(() => {
      autoTag = true;
    });

    it('skips a pool no member of which was re-elected', async () => {
      islandingPool();

      await poolSharedExternals(new Map([[GLOBAL_SCOPE, new Set(['unrelated-dep'])]]));

      // Named (`syncPoolNames` runs for the whole touched scope), but no verdict is decided.
      expect(rebuilds()).toEqual([]);
      expect(config.log.debug).not.toHaveBeenCalledWith(3, expect.stringContaining('pool:'));
    });

    it('processes the whole pool when any single member was re-elected', async () => {
      islandingPool();

      await poolSharedExternals(new Map([[GLOBAL_SCOPE, new Set(['@framework/core'])]]));

      // Both members, not just the re-elected one: islanding `c` scopes its whole family.
      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledTimes(2);
    });

    it('does not even read a scope with nothing re-elected', async () => {
      islandingPool();

      await poolSharedExternals(new Map([['other-scope', new Set(['@framework/core'])]]));

      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('processes every pool when called without a signal', async () => {
      islandingPool();

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledTimes(2);
    });
  });

  describe('membership', () => {
    it('pools via an explicit remote pool tag', async () => {
      givenExternals({
        foo: external([
          sharedVersion('17', [meta('mfe1', { pool: 'grp' }), meta('mfe2', { pool: 'grp' })], {
            action: 'share',
          }),
        ]),
        bar: external([
          sharedVersion('17', [meta('mfe2', { pool: 'grp' }), meta('mfe1', { pool: 'grp' })], {
            action: 'share',
          }),
        ]),
      });

      await poolSharedExternals();

      expectPooled('grp');
      expect(config.log.debug).toHaveBeenCalledWith(
        3,
        expect.stringContaining('2 members across 2 remotes')
      );
    });
  });

  // Islanding nobody means every member keeps the verdict determine gave it, so pooling rebuilds
  // nothing (W1) instead of rebuilding each member into an identical value. It still names the pool
  // (`syncPoolNames`) where the stored name differs — the fixtures here seed none.
  describe('defers to the base resolver for compatible families', () => {
    it('keeps every member shared, no scoping, when nothing is incompatible', async () => {
      autoTag = true;
      const externals = {
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('mfe2'), meta('mfe1')], { action: 'share' }),
        ]),
      };
      givenExternals(externals);

      await poolSharedExternals();

      expectPooled('framework');
      expect(rebuilds()).toEqual([]);
      for (const stored of Object.values(externals)) {
        expect(namesOf(stored, 'share')).toEqual(['mfe1', 'mfe2']);
        expect(stored.versions.some(v => v.action === 'scope')).toBe(false);
      }
    });

    it('leaves a single-provider member shared instead of scoping it (no anchor coverage penalty)', async () => {
      autoTag = true;
      // m2 is provided by Q alone. Under the old anchor model an anchor that lacked m2 orphaned it;
      // now a compatible single-provider member simply stays shared.
      const externals = {
        '@pool/m1': external([
          sharedVersion('1', [meta('P', { req: '1' }), meta('Q', { req: '1' })], {
            action: 'share',
          }),
        ]),
        '@pool/m2': external([sharedVersion('1', [meta('Q', { req: '1' })], { action: 'share' })]),
      };
      givenExternals(externals);

      await poolSharedExternals();

      expect(rebuilds()).toEqual([]);
      expect(namesOf(externals['@pool/m1'], 'share')).toEqual(['P', 'Q']);
      expect(namesOf(externals['@pool/m2'], 'share')).toEqual(['Q']);
      expect(externals['@pool/m2'].versions.some(v => v.action === 'scope')).toBe(false);
    });

    it('clears an anchor this election did not grant', async () => {
      autoTag = true;
      // A warm init re-elects the pool as a unit, so the record it reads still carries the `servedBy` of the
      // previous portfolio. Here nobody needs an anchor any more, and the pool would otherwise take the
      // no-op path and leave mfe2 pointed at mfe1's files — an assignment gate 2 never made this time.
      const externals = {
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1'), { ...meta('mfe2'), servedBy: 'mfe1' }], {
            action: 'share',
          }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
      };
      givenExternals(externals);

      await poolSharedExternals();

      expect(servedByOf(rebuiltFor('@framework/core')!)).toEqual({});
      expect(namesOf(rebuiltFor('@framework/core')!, 'share')).toEqual(['mfe1', 'mfe2']);
    });

    it('preserves the base resolver host winner', async () => {
      autoTag = true;
      const build = () =>
        external([
          sharedVersion('17', [meta('host')], { host: true, action: 'share' }),
          sharedVersion('18', [meta('mfe1', { req: '18' })]),
        ]);
      const externals = { '@framework/core': build(), '@framework/common': build() };
      givenExternals(externals);

      await poolSharedExternals();

      expect(rebuilds()).toEqual([]);
      const share = externals['@framework/core'].versions.find(v => v.action === 'share')!;
      expect(share.host).toBe(true);
      expect(share.remotes[0]!.name).toBe('host');
    });

    it('reads determine actions without calling versionCheck.isCompatible', async () => {
      autoTag = true;
      const isCompatible = vi.fn(() => true);
      adapters.versionCheck.isCompatible = isCompatible;
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      expect(isCompatible).not.toHaveBeenCalled();
    });
  });

  describe('islands version-incompatible remotes (family-island gate)', () => {
    it('scopes an islanded remote across the whole family, no dedup on its matching copy', async () => {
      autoTag = true;
      // determine marked mfe3's core@18 `scope`; mfe3 also ships common@17, matching the 17 winner.
      // Islanding must still scope that matching copy (no dedup) to keep mfe3's family coherent.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1', { req: '17' }), meta('mfe2', { req: '17' })], {
            action: 'share',
          }),
          sharedVersion('18', [meta('mfe3', { req: '18', strict: true })], { action: 'scope' }),
        ]),
        '@framework/common': external([
          sharedVersion(
            '17',
            [meta('mfe1', { req: '17' }), meta('mfe2', { req: '17' }), meta('mfe3', { req: '17' })],
            { action: 'share' }
          ),
        ]),
      });

      await poolSharedExternals();

      const core = rebuiltFor('@framework/core')!;
      expect(namesOf(core, 'share')).toEqual(['mfe1', 'mfe2']);
      expect(namesOf(core, 'scope')).toEqual(['mfe3']);

      const common = rebuiltFor('@framework/common')!;
      expect(namesOf(common, 'share')).toEqual(['mfe1', 'mfe2']);
      expect(namesOf(common, 'scope')).toEqual(['mfe3']);
    });

    it('warns once per islanded remote, naming the member and tag that made it impossible', async () => {
      autoTag = true;
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a', { req: '17' })], { action: 'share' }),
          sharedVersion('18', [meta('c', { req: '18' })], { action: 'scope' }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('a', { req: '17' })], { action: 'share' }),
          sharedVersion('18', [meta('c', { req: '18' })], { action: 'scope' }),
        ]),
      });

      await poolSharedExternals();

      const warnings = vi
        .mocked(config.log.warn)
        .mock.calls.filter(c => String(c[1]).includes("'c' is islanded"));
      expect(warnings).toHaveLength(1);
      // Says what pooling knows — determine wrote this verdict — not that pooling found an
      // incompatibility of its own. See F-D-review-nits.md §3.
      expect(warnings[0]![1]).toContain("the resolver scoped its '@framework/common@18'");
      // c declares both members of this pool, so what it imports and the pool coincide here.
      expect(warnings[0]![1]).toContain('all 2 members it imports are scoped');
    });

    it('writes every member once it has islanded someone', async () => {
      autoTag = true;
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a', { req: '17' })], { action: 'share' }),
          sharedVersion('18', [meta('c', { req: '18' })], { action: 'scope' }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('a', { req: '17' }), meta('c', { req: '17' })], {
            action: 'share',
          }),
        ]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledTimes(2);
    });

    it('islands a remote whose uncovered entrypoint would come from its own build', async () => {
      autoTag = true;
      // The gate used to short-circuit as soon as one build was the basis of every *member*, on the
      // argument that it therefore covered everyone. It does not: mfe1 wins both members but does not
      // bundle `@framework/core/testing`, so `generate-import-map` self-fills that specifier from mfe2's
      // own 17.0.6 build into the global imports — mfe2 then runs core@17.0.8 beside core/testing@17.0.6,
      // and so does every other remote importing that entrypoint. Coverage is a specifier question, which
      // is exactly what `coversWholePool` now asks before taking the free path.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.8', [meta('mfe1', { req: '^17.0.0', file: 'core.js' })], {
            action: 'share',
          }),
          sharedVersion('17.0.6', [
            {
              ...meta('mfe2', { req: '^17.0.0' }),
              entries: {
                '@framework/core': 'core.js',
                '@framework/core/testing': 'core-testing.js',
              },
            },
          ]),
        ]),
        '@framework/common': external([
          sharedVersion('17.0.8', [meta('mfe1', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.0.6', [meta('mfe2', { req: '^17.0.0' })]),
        ]),
      });

      await poolSharedExternals();

      const core = rebuiltFor('@framework/core')!;
      expect(namesOf(core, 'share')).toEqual(['mfe1']);
      expect(namesOf(core, 'scope')).toEqual(['mfe2']);
      expect(namesOf(rebuiltFor('@framework/common')!, 'scope')).toEqual(['mfe2']);
      expect(config.log.warn).toHaveBeenCalledWith(
        3,
        expect.stringContaining(
          "'mfe2' serves its own family: no shared build offers every entrypoint it imports at a version it accepts — '@framework/core/testing' is the gap, closest is 'mfe1'."
        )
      );
    });

    it('still takes the free path when the one basis covers every entrypoint', async () => {
      autoTag = true;
      // The same patch drift with nothing uncovered: mfe1's build serves every specifier mfe2 imports at
      // the tags the map publishes, so mfe2 is witnessed and pooling rebuilds nothing.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.8', [meta('mfe1', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.0.6', [meta('mfe2', { req: '^17.0.0' })]),
        ]),
        '@framework/common': external([
          sharedVersion('17.0.8', [meta('mfe1', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.0.6', [meta('mfe2', { req: '^17.0.0' })]),
        ]),
      });

      await poolSharedExternals();

      expect(rebuilds()).toEqual([]);
      expect(config.log.warn).not.toHaveBeenCalled();
    });

    it('islands a remote no shared build serves its whole family', async () => {
      autoTag = true;
      // b draws core from a (17.0.0) and cdk from itself (17.1.0). The old gate read that as a minor-line
      // disagreement; the coverage gate reaches the same verdict for a stronger reason — no build ships
      // both members, and b's own tags are not the shared ones, so nothing witnesses the pair it would
      // run. The message therefore names the member coverage broke on, not two tags.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })]),
        ]),
        '@framework/cdk': external([
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      const core = rebuiltFor('@framework/core')!;
      expect(namesOf(core, 'share')).toEqual(['a']);
      expect(namesOf(core, 'scope')).toEqual(['b']);
      expect(config.log.warn).toHaveBeenCalledWith(
        3,
        expect.stringContaining(
          "'b' serves its own family: no shared build offers every entrypoint it imports at a version it accepts — '@framework/cdk' is the gap"
        )
      );
    });

    it('islands patch drift across two builds, which no build witnesses', async () => {
      autoTag = true;
      // Same topology one minor line down. The old gate tolerated this by design: 17.0.6 beside 17.0.8 is
      // benign patch drift, so b kept deduping core from a while running its own cdk. Under the promise
      // that is a pair no build shipped, and minor lines are not read at all — so b serves its own family
      // and pays one extra download. The portfolio whose cost this records: 2 downloads before, 3 after.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.6', [meta('a', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.0.8', [meta('b', { req: '^17.0.0' })]),
        ]),
        '@framework/cdk': external([
          sharedVersion('17.0.8', [meta('b', { req: '^17.0.0' })], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      const core = rebuiltFor('@framework/core')!;
      expect(namesOf(core, 'share')).toEqual(['a']);
      expect(namesOf(core, 'scope')).toEqual(['b']);
      expect(config.log.warn).toHaveBeenCalledWith(
        3,
        expect.stringContaining("'b' serves its own family")
      );
    });

    it('names the version a covering build offers when that is what the consumer refuses', async () => {
      autoTag = true;
      // The other way a build fails the gate: b's build covers every entrypoint c imports, so the gap is
      // not coverage at all — it is that c pins `~17.0.0` and b offers core@17.1.0. The warning has to say
      // so, or the owner of the portfolio goes looking for a missing entrypoint that is not missing.
      // b itself self-serves for the ordinary reason: only b ships `only-b`, so nothing covers it.
      adapters.versionCheck.isCompatible = vi.fn(
        (tag, range) => range !== '~17.0.0' || tag.startsWith('17.0.')
      );
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('c', { req: '~17.0.0' })], {
            action: 'share',
          }),
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })]),
        ]),
        '@framework/util': external([
          sharedVersion('17.2.0', [meta('b', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.1.0', [meta('c', { req: '^17.0.0' })]),
        ]),
        '@framework/only-b': external([
          sharedVersion('17.2.0', [meta('b', { req: '^17.0.0' })], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      expect(config.log.warn).toHaveBeenCalledWith(
        3,
        expect.stringContaining(
          "'c' serves its own family: no shared build offers every entrypoint it imports at a version it accepts — '@framework/core@17.1.0' is the gap, closest is 'b'."
        )
      );
    });

    it('islands a remote nothing covers, without dragging its co-consumers down with it', async () => {
      autoTag = true;
      // Nothing covers b — only b ships `only-b` — and no build ships the combination the global mapping
      // would hand it, so b serves its own family. d is untouched: it takes core@17.0.0 from a and util
      // from its own copy, which is exactly what its own build compiled, so it stays witnessed even after
      // b's islanding takes util's `share` version with it. The old gate islanded d here too, because it
      // read util as having left the shared set — but d's own copy still maps it, at d's own tag.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('d', { req: '^17.0.0' })], {
            action: 'share',
          }),
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })]),
        ]),
        '@framework/util': external([
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.1.0', [meta('d', { req: '^17.0.0' })], { action: 'skip' }),
        ]),
        '@framework/only-b': external([
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      const core = rebuiltFor('@framework/core')!;
      expect(namesOf(core, 'share')).toEqual(['a', 'd']);
      expect(namesOf(core, 'scope')).toEqual(['b']);
      expect(servedByOf(core)).toEqual({});
    });

    it('anchors a remote onto a covering build and maps that build onto itself', async () => {
      autoTag = true;
      // The shape that merged emission into the gate. Neither b nor d is witnessed: the global mapping
      // offers core@17.0.0 beside util@17.1.0 and no build shipped that pair. b's build covers d, so d
      // takes b's whole family — and b, which does not win core globally, needs the same entry for
      // *itself*, or its util file would resolve its peers through the global core one hop in
      // (constraint 4). Both entries name b's build; nothing is islanded and nothing is scoped.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' }), meta('d', { req: '^17.0.0' })], {
            action: 'share',
          }),
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' }), meta('c', { req: '^17.0.0' })], {
            action: 'skip',
          }),
        ]),
        '@framework/util': external([
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.1.0', [meta('c', { req: '^17.0.0' })], { action: 'skip' }),
        ]),
      });

      await poolSharedExternals();

      const core = rebuiltFor('@framework/core')!;
      expect(namesOf(core, 'share')).toEqual(['a', 'd']);
      expect(namesOf(core, 'scope')).toEqual([]);
      expect(servedByOf(core)).toEqual({ b: 'b', c: 'b' });

      const util = rebuiltFor('@framework/util')!;
      expect(namesOf(util, 'share')).toEqual(['b']);
      expect(servedByOf(util)).toEqual({});
      expect(config.log.warn).not.toHaveBeenCalledWith(3, expect.stringContaining('islanded'));
    });

    it('groups scope versions by each remote real tag (F3)', async () => {
      autoTag = true;
      givenExternals({
        '@framework/core': external([
          sharedVersion('22.0.6', [meta('a', { req: '22' }), meta('b', { req: '22' })], {
            action: 'share',
          }),
          sharedVersion('21.2.17', [meta('c', { req: '21', strict: true })], { action: 'scope' }),
        ]),
        '@framework/common': external([
          sharedVersion('22.0.6', [meta('a', { req: '22' }), meta('b', { req: '22' })], {
            action: 'share',
          }),
          sharedVersion('22.0.5', [meta('c', { req: '22' })]),
        ]),
      });

      await poolSharedExternals();

      const coreScope = rebuiltFor('@framework/core')!.versions.find(v => v.action === 'scope')!;
      expect(coreScope.tag).toBe('21.2.17');
      expect(coreScope.remotes.map(r => r.name)).toEqual(['c']);

      // c's common copy (22.0.5) is islanded via the sibling conflict; its scope tag is its real one.
      const commonScope = rebuiltFor('@framework/common')!.versions.find(
        v => v.action === 'scope'
      )!;
      expect(commonScope.tag).toBe('22.0.5');
      expect(commonScope.remotes.map(r => r.name)).toEqual(['c']);
    });

    it('scopes a member whose only shared build was islanded away (orphaned skip)', async () => {
      autoTag = true;
      // c is islanded via core@18. cdk winner is c@18 (share); b@18 dedups onto it (skip). With c
      // islanded, cdk has no shared build, so b's skip self-serves too — cdk is scope-only.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a', { req: '17' })], { action: 'share' }),
          sharedVersion('18', [meta('c', { req: '18', strict: true })], { action: 'scope' }),
        ]),
        '@framework/cdk': external([
          sharedVersion('18', [meta('c', { req: '18' })], { action: 'share' }),
          sharedVersion('18', [meta('b', { req: '18' })], { action: 'skip' }),
        ]),
      });

      await poolSharedExternals();

      const cdk = rebuiltFor('@framework/cdk')!;
      expect(cdk.versions.every(v => v.action === 'scope')).toBe(true);
      expect(namesOf(cdk, 'scope')).toEqual(['b', 'c']);
    });
  });

  describe('scoped-only warning (F4)', () => {
    it('stays silent when an island in the same pass took the last provider', async () => {
      autoTag = true;
      // cdk's only shared build was c's, and c is islanded via core@18. The island warning already
      // named that cause, so restating its effect would be a double warning.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a', { req: '17' })], { action: 'share' }),
          sharedVersion('18', [meta('c', { req: '18', strict: true })], { action: 'scope' }),
        ]),
        '@framework/cdk': external([
          sharedVersion('18', [meta('c', { req: '18' })], { action: 'share' }),
          sharedVersion('18', [meta('b', { req: '18' })], { action: 'skip' }),
        ]),
      });

      await poolSharedExternals();

      expect(config.log.warn).not.toHaveBeenCalledWith(
        3,
        expect.stringContaining("'@framework/cdk' is scoped-only")
      );
      expect(config.log.warn).toHaveBeenCalledWith(
        3,
        expect.stringContaining("'c' is islanded: the resolver scoped its '@framework/core@18'")
      );
    });

    it('warns when sharing was lost without an island taking the provider', async () => {
      autoTag = true;
      // d is islanded on core, and cdk ends up scope-only because determine had already scoped its
      // only version. b declares both members, which is what forms the pool at all: tags are
      // remote-local, so a scope with no remote shipping two of its members is not a pool and pooling
      // would never look at this portfolio.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a', { req: '17' }), meta('b', { req: '17' })], {
            action: 'share',
          }),
          sharedVersion('18', [meta('d', { req: '18', strict: true })], { action: 'scope' }),
        ]),
        '@framework/cdk': external([
          sharedVersion('18', [meta('b', { req: '18' }), meta('e', { req: '18' })], {
            action: 'scope',
          }),
        ]),
      });

      await poolSharedExternals();

      expect(config.log.warn).toHaveBeenCalledWith(
        3,
        expect.stringContaining("'@framework/cdk' is scoped-only")
      );
    });

    it('stays silent for a single-consumer scoped-only member', async () => {
      autoTag = true;
      // priv is shipped only by the islanded c, so it is scoped-only but one download either way.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a', { req: '17' })], { action: 'share' }),
          sharedVersion('18', [meta('c', { req: '18', strict: true })], { action: 'scope' }),
        ]),
        '@framework/priv': external([
          sharedVersion('18', [meta('c', { req: '18' })], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      expect(config.log.warn).not.toHaveBeenCalledWith(
        3,
        expect.stringContaining("'@framework/priv' is scoped-only")
      );
    });

    it('does not warn when every member is shared', async () => {
      autoTag = true;
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      expect(config.log.warn).not.toHaveBeenCalledWith(
        3,
        expect.stringContaining('is scoped-only')
      );
    });
  });

  describe('strict compatibility', () => {
    it('does not throw for a compatible family with a single-provider member', async () => {
      autoTag = true;
      config.strict.strictExternalCompatibility = true;
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a'), meta('b')], { action: 'share' }),
        ]),
        '@framework/common': external([sharedVersion('17', [meta('a')], { action: 'share' })]),
        '@framework/cdk': external([sharedVersion('17', [meta('b')], { action: 'share' })]),
      });

      await expect(poolSharedExternals()).resolves.toBeUndefined();

      expect(rebuilds()).toEqual([]);
    });

    it('does not throw when a remote serves its own family for lack of coverage', async () => {
      autoTag = true;
      config.strict.strictExternalCompatibility = true;
      // b is islanded by the coverage gate, not by an incompatibility: every range here accepts every tag,
      // so nothing about its versions is wrong and a strict portfolio must not fail on it (constraint 10).
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.6', [meta('a', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.0.8', [meta('b', { req: '^17.0.0' })]),
        ]),
        '@framework/cdk': external([
          sharedVersion('17.0.8', [meta('b', { req: '^17.0.0' })], { action: 'share' }),
        ]),
      });

      await expect(poolSharedExternals()).resolves.toBeUndefined();

      expect(namesOf(rebuiltFor('@framework/core')!, 'scope')).toEqual(['b']);
    });

    it('throws under strictExternalCompatibility when a remote is islanded', async () => {
      autoTag = true;
      config.strict.strictExternalCompatibility = true;
      const build = () =>
        external([
          sharedVersion('17', [meta('a', { req: '17' }), meta('b', { req: '17' })], {
            action: 'share',
          }),
          sharedVersion('18', [meta('c', { req: '18', strict: true })], { action: 'scope' }),
        ]);
      givenExternals({ '@framework/core': build(), '@framework/common': build() });

      await expect(poolSharedExternals()).rejects.toThrow(NFError);
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });
  });

  // What pooling stores for tools to read: the pool an external is in (`SharedExternal.poolName`) and, per
  // scoped copy, why it self-serves (`poolCause`). See docs/version-resolver.md §"What pooling stores".
  describe('stored pool state', () => {
    const causeOf = (external: SharedExternal, remote: string) =>
      external.versions.flatMap(v => v.remotes).find(r => r.name === remote)?.poolCause;

    // mfe3 is islanded on core@18 and ships the matching common@17 too.
    const islanding = () => ({
      '@framework/core': external([
        sharedVersion('17', [meta('mfe1', { req: '17' })], { action: 'share' }),
        sharedVersion('18', [meta('mfe3', { req: '18' })], { action: 'scope' }),
      ]),
      '@framework/common': external([
        sharedVersion('17', [meta('mfe1', { req: '17' }), meta('mfe3', { req: '17' })], {
          action: 'share',
        }),
      ]),
    });

    beforeEach(() => {
      autoTag = true;
    });

    it('writes the pool name onto every rebuilt member', async () => {
      givenExternals(islanding());

      await poolSharedExternals();

      expect(rebuiltFor('@framework/core')!.poolName).toBe('framework');
      expect(rebuiltFor('@framework/common')!.poolName).toBe('framework');
    });

    it("marks every copy of an islanded remote 'incompatible', and no clean copy", async () => {
      givenExternals(islanding());

      await poolSharedExternals();

      // Including common@17, which matched the winner: it is scoped because of core, not itself.
      expect(causeOf(rebuiltFor('@framework/core')!, 'mfe3')).toBe('incompatible');
      expect(causeOf(rebuiltFor('@framework/common')!, 'mfe3')).toBe('incompatible');
      expect(causeOf(rebuiltFor('@framework/core')!, 'mfe1')).toBeUndefined();
      expect(causeOf(rebuiltFor('@framework/common')!, 'mfe1')).toBeUndefined();
    });

    it("marks a gate-2 self-serve 'uncovered'", async () => {
      // Same fixture as 'islands a remote no shared build serves its whole family'.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17.0.0', [meta('a', { req: '^17.0.0' })], { action: 'share' }),
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })]),
        ]),
        '@framework/cdk': external([
          sharedVersion('17.1.0', [meta('b', { req: '^17.0.0' })], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      expect(causeOf(rebuiltFor('@framework/core')!, 'b')).toBe('uncovered');
      expect(causeOf(rebuiltFor('@framework/cdk')!, 'b')).toBe('uncovered');
      expect(causeOf(rebuiltFor('@framework/core')!, 'a')).toBeUndefined();
    });

    it("marks a copy swept off a member that lost every provider 'unshared'", async () => {
      // Same fixture as 'scopes a member whose only shared build was islanded away': b is not islanded,
      // it just has nobody left to dedup onto.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a', { req: '17' })], { action: 'share' }),
          sharedVersion('18', [meta('c', { req: '18' })], { action: 'scope' }),
        ]),
        '@framework/cdk': external([
          sharedVersion('18', [meta('c', { req: '18' })], { action: 'share' }),
          sharedVersion('18', [meta('b', { req: '18' })], { action: 'skip' }),
        ]),
      });

      await poolSharedExternals();

      const cdk = rebuiltFor('@framework/cdk')!;
      expect(causeOf(cdk, 'b')).toBe('unshared');
      expect(causeOf(cdk, 'c')).toBe('incompatible');
    });

    it('clears a stale poolCause on a re-election that otherwise needs nothing', async () => {
      // A healthy pool would take the no-op path, but the record still says mfe2 self-served last time.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1'), { ...meta('mfe2'), poolCause: 'uncovered' }], {
            action: 'share',
          }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      expect(causeOf(rebuiltFor('@framework/core')!, 'mfe2')).toBeUndefined();
      expect(namesOf(rebuiltFor('@framework/core')!, 'share')).toEqual(['mfe1', 'mfe2']);
    });

    it('writes nothing for a healthy re-election whose stored names already match', async () => {
      givenExternals({
        '@framework/core': {
          ...external([sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' })]),
          poolName: 'framework',
        },
        '@framework/common': {
          ...external([sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' })]),
          poolName: 'framework',
        },
      });

      await poolSharedExternals();

      expectPooled('framework');
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('renames an untouched pool whose stored name differs, without rebuilding it', async () => {
      const externals = islanding();
      for (const stored of Object.values(externals)) stored.poolName = 'old-name';
      givenExternals(externals);

      // The scope is touched, the pool is not: its verdicts stand, only the name is brought up to date.
      await poolSharedExternals(new Map([[GLOBAL_SCOPE, new Set(['unrelated-dep'])]]));

      expect(rebuilds()).toEqual([]);
      expect(nameWrites().map(c => [c[0], c[1].poolName])).toEqual([
        ['@framework/core', 'framework'],
        ['@framework/common', 'framework'],
      ]);
    });

    it('clears pool and poolCause off an external that is in no pool any more', async () => {
      // `lonely` was pooled by an earlier portfolio; nothing tags it now (unscoped, so no scope tag).
      const lonely: SharedExternal = {
        ...external([
          sharedVersion('1', [{ ...meta('mfe1', { req: '1' }), poolCause: 'incompatible' }], {
            action: 'scope',
          }),
        ]),
        poolName: 'framework',
      };
      givenExternals({ ...islanding(), lonely });

      await poolSharedExternals();

      const written = writes().find(c => c[0] === 'lonely')?.[1];
      expect(written).toBeDefined();
      expect(written!.poolName).toBeUndefined();
      expect(causeOf(written!, 'mfe1')).toBeUndefined();
    });
  });
});
