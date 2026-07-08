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

type MetaOpt = { req?: string; strict?: boolean; cached?: boolean; pool?: string; file?: string };

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

const external = (versions: SharedVersion[], dirty = false): SharedExternal => ({ dirty, versions });

describe('createPoolSharedExternals', () => {
  let poolSharedExternals: ForPoolingSharedExternals;
  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    adapters.sharedExternalsRepo.getScopes = vi.fn(() => [GLOBAL_SCOPE]);
    adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'global' as const);
    adapters.versionCheck.isCompatible = vi.fn(() => true);
    adapters.versionCheck.compare = vi.fn((a, b) => a.localeCompare(b));

    poolSharedExternals = createPoolSharedExternals(config, adapters);
  });

  const givenExternals = (externals: Record<string, SharedExternal>) => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => externals);
  };

  const rebuiltFor = (name: string): SharedExternal | undefined =>
    vi.mocked(adapters.sharedExternalsRepo.addOrUpdate).mock.calls.find(c => c[0] === name)?.[1];

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
      config.profile.useAutoExternalPooling = true;
      givenExternals({
        '@framework/core': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
        '@framework/common': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('is a no-op for a single-member pool', async () => {
      config.profile.useAutoExternalPooling = true;
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
      config.profile.useAutoExternalPooling = true;
      adapters.sharedExternalsRepo.getScopes = vi.fn(() => ['strict']);
      adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'strict' as const);

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });
  });

  describe('has-pool early-out', () => {
    it('skips the scope walk entirely when auto-pooling is off and no pool tag was seen', async () => {
      config.profile.useAutoExternalPooling = false;
      adapters.sharedExternalsRepo.hasPoolTag = vi.fn(() => false);

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.getScopes).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('still pools when a pool tag was seen even with auto-pooling off', async () => {
      config.profile.useAutoExternalPooling = false;
      adapters.sharedExternalsRepo.hasPoolTag = vi.fn(() => true);
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
      expect(rebuiltFor('foo')?.versions[0]!.remotes[0]!.name).toBe('mfe1');
    });

    it('never early-outs when auto-pooling is on, regardless of the pool-tag memo', async () => {
      config.profile.useAutoExternalPooling = true;
      adapters.sharedExternalsRepo.hasPoolTag = vi.fn(() => false);
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.getFromScope).toHaveBeenCalled();
      expect(rebuiltFor('@framework/core')).toBeDefined();
    });
  });

  describe('membership', () => {
    it('pools via an explicit remote pool tag even when auto-pooling is off', async () => {
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

      expect(rebuiltFor('foo')?.versions[0]!.remotes[0]!.name).toBe('mfe1');
      expect(rebuiltFor('bar')?.versions[0]!.remotes[0]!.name).toBe('mfe1');
    });
  });

  describe('anchoring', () => {
    it('re-points every member of an auto-pool to a single anchor remote', async () => {
      config.profile.useAutoExternalPooling = true;
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
        // note: mfe2 listed first — pooling must re-point this to the mfe1 anchor.
        '@framework/common': external([
          sharedVersion('17', [meta('mfe2'), meta('mfe1')], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      const core = rebuiltFor('@framework/core')!;
      const common = rebuiltFor('@framework/common')!;
      expect(core.versions).toHaveLength(1);
      expect(core.versions[0]!.action).toBe('share');
      expect(core.versions[0]!.remotes[0]!.name).toBe('mfe1');
      expect(common.versions[0]!.remotes[0]!.name).toBe('mfe1');
    });

    it('prefers the host remote as anchor', async () => {
      config.profile.useAutoExternalPooling = true;
      const build = () =>
        external([
          sharedVersion('17', [meta('host')], { host: true, action: 'share' }),
          sharedVersion('18', [meta('mfe1', { req: '18' })]),
        ]);
      givenExternals({ '@framework/core': build(), '@framework/common': build() });

      await poolSharedExternals();

      const share = rebuiltFor('@framework/core')!.versions.find(v => v.action === 'share')!;
      expect(share.remotes[0]!.name).toBe('host');
    });
  });

  describe('all-or-nothing classification', () => {
    it('scopes a strict-incompatible remote entire family, others follow', async () => {
      config.profile.useAutoExternalPooling = true;
      // determine already scoped the strict-incompatible v18 (action 'scope'); pooling reads that.
      const build = () =>
        external([
          sharedVersion('17', [meta('mfe1', { req: '17' }), meta('mfe2', { req: '17' })], {
            action: 'share',
          }),
          sharedVersion('18', [meta('mfe3', { req: '18', strict: true })], { action: 'scope' }),
        ]);
      givenExternals({ '@framework/core': build(), '@framework/common': build() });

      await poolSharedExternals();

      const core = rebuiltFor('@framework/core')!;
      const share = core.versions.find(v => v.action === 'share')!;
      const scope = core.versions.find(v => v.action === 'scope')!;
      expect(share.remotes.map(r => r.name)).toEqual(['mfe1', 'mfe2']);
      expect(scope.remotes.map(r => r.name)).toEqual(['mfe3']);

      // Family coherence: @framework/common lands its mfe3 family in scope too.
      const common = rebuiltFor('@framework/common')!;
      expect(common.versions.find(v => v.action === 'scope')!.remotes.map(r => r.name)).toEqual([
        'mfe3',
      ]);
    });
  });

  describe('partial anchor (no remote covers the union)', () => {
    const disjoint = () => ({
      '@framework/core': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
      '@framework/common': external([sharedVersion('17', [meta('mfe2')], { action: 'share' })]),
    });

    it('pools around the best partial anchor, orphan member scoped-only', async () => {
      config.profile.useAutoExternalPooling = true;
      givenExternals(disjoint());

      await poolSharedExternals();

      // Anchor is mfe1 (covers @framework/core): core shares from mfe1.
      const core = rebuiltFor('@framework/core')!;
      expect(core.versions).toHaveLength(1);
      expect(core.versions[0]!.action).toBe('share');
      expect(core.versions[0]!.remotes.map(r => r.name)).toEqual(['mfe1']);

      // @framework/common is an orphan — mfe1 provides no build for it — so it resolves scoped-only.
      const common = rebuiltFor('@framework/common')!;
      expect(common.versions.every(v => v.action === 'scope')).toBe(true);
      expect(common.versions.flatMap(v => v.remotes.map(r => r.name))).toEqual(['mfe2']);
    });

    it('does not throw under strictImportMap (a partial anchor always exists)', async () => {
      config.profile.useAutoExternalPooling = true;
      config.strict.strictImportMap = true;
      givenExternals(disjoint());

      await expect(poolSharedExternals()).resolves.toBeUndefined();
      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalled();
    });

    it('warns that the orphan member is scoped-only', async () => {
      config.profile.useAutoExternalPooling = true;
      givenExternals(disjoint());

      await poolSharedExternals();

      expect(config.log.warn).toHaveBeenCalledWith(
        3,
        expect.stringContaining("'@framework/common' is scoped-only")
      );
    });

    it('does not warn when every member is shared', async () => {
      config.profile.useAutoExternalPooling = true;
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

  describe('coverage dedup vs incompatibility scope-all', () => {
    it('dedups a coverage-forced remote on same-version members but scopes an incompat family whole', async () => {
      config.profile.useAutoExternalPooling = true;
      // Anchor 'a' covers core+common. 'b' is coverage-forced (uses orphan cdk; core@17 matches).
      // 'c' is incompatibility-forced (core@18, determine marked it 'scope').
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a', { req: '17' }), meta('b', { req: '17' })], {
            action: 'share',
          }),
          sharedVersion('18', [meta('c', { req: '18', strict: true })], { action: 'scope' }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('a', { req: '17' }), meta('c', { req: '17' })], {
            action: 'share',
          }),
        ]),
        '@framework/cdk': external([sharedVersion('17', [meta('b', { req: '17' })], { action: 'share' })]),
      });

      await poolSharedExternals();

      // core: 'b' (coverage-forced, same version 17) dedups → shares alongside anchor 'a';
      //       'c' (incompat) scopes.
      const core = rebuiltFor('@framework/core')!;
      const coreShare = core.versions.find(v => v.action === 'share')!;
      expect(coreShare.remotes.map(r => r.name).sort()).toEqual(['a', 'b']);
      expect(core.versions.find(v => v.action === 'scope')!.remotes.map(r => r.name)).toEqual(['c']);

      // common: 'c' scopes its WHOLE family (incompat) — no dedup even though common@17 matches.
      const common = rebuiltFor('@framework/common')!;
      expect(common.versions.find(v => v.action === 'share')!.remotes.map(r => r.name)).toEqual([
        'a',
      ]);
      expect(common.versions.find(v => v.action === 'scope')!.remotes.map(r => r.name)).toEqual([
        'c',
      ]);

      // cdk: orphan (anchor 'a' lacks it) → 'b' scoped-only.
      const cdk = rebuiltFor('@framework/cdk')!;
      expect(cdk.versions.every(v => v.action === 'scope')).toBe(true);
      expect(cdk.versions.flatMap(v => v.remotes.map(r => r.name))).toEqual(['b']);
    });
  });

  describe('conservative path (reads determine, no compatibility check)', () => {
    it('anchors a full-coverage pool without calling versionCheck.isCompatible', async () => {
      config.profile.useAutoExternalPooling = true;
      const isCompatible = vi.fn(() => true);
      adapters.versionCheck.isCompatible = isCompatible;
      // One remote (mfe1) provides the winning tag for every member — the full-witness case.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      const core = rebuiltFor('@framework/core')!;
      expect(core.versions).toHaveLength(1);
      expect(core.versions[0]!.action).toBe('share');
      expect(core.versions[0]!.remotes.map(r => r.name)).toEqual(['mfe1', 'mfe2']);
      // The cheap path: classification reads determine's actions, never re-checks versions.
      expect(isCompatible).not.toHaveBeenCalled();
    });

    it('anchors the max-coverage remote (P/Q), sharing a member only one remote provides', async () => {
      config.profile.useAutoExternalPooling = true;
      // m1 is provided by P and Q, m2 only by Q. Q covers both, so it anchors and m2 is shared — not
      // name-earliest P, which would orphan m2.
      givenExternals({
        '@pool/m1': external([
          sharedVersion('1', [meta('P', { req: '1' }), meta('Q', { req: '1' })], { action: 'share' }),
        ]),
        '@pool/m2': external([sharedVersion('1', [meta('Q', { req: '1' })], { action: 'share' })]),
      });

      await poolSharedExternals();

      const m1 = rebuiltFor('@pool/m1')!;
      expect(m1.versions.find(v => v.action === 'share')!.remotes[0]!.name).toBe('Q');

      const m2 = rebuiltFor('@pool/m2')!;
      expect(m2.versions.find(v => v.action === 'share')!.remotes.map(r => r.name)).toEqual(['Q']);
    });
  });

  describe('strict compatibility', () => {
    it('does not throw under strictExternalCompatibility for a coverage-forced remote', async () => {
      config.profile.useAutoExternalPooling = true;
      config.strict.strictExternalCompatibility = true;
      // 'b' is coverage-forced (uses cdk, which anchor 'a' lacks). A coverage gap is not a version
      // conflict, so strict mode must NOT abort.
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a'), meta('b')], { action: 'share' }),
        ]),
        '@framework/common': external([sharedVersion('17', [meta('a')], { action: 'share' })]),
        '@framework/cdk': external([sharedVersion('17', [meta('b')], { action: 'share' })]),
      });

      await expect(poolSharedExternals()).resolves.toBeUndefined();

      // core shares from anchor 'a'; 'b' dedups its same-version copy; cdk is scoped-only on 'b'.
      const core = rebuiltFor('@framework/core')!;
      expect(core.versions.find(v => v.action === 'share')!.remotes.map(r => r.name).sort()).toEqual([
        'a',
        'b',
      ]);
      const cdk = rebuiltFor('@framework/cdk')!;
      expect(cdk.versions.every(v => v.action === 'scope')).toBe(true);
    });

    it('throws under strictExternalCompatibility when a member is version-incompatible', async () => {
      config.profile.useAutoExternalPooling = true;
      config.strict.strictExternalCompatibility = true;
      // 'c' is strict-incompatible (determine marked its v18 `scope`) — a genuine conflict, not a
      // coverage gap, so strict mode rejects the pool.
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
});
