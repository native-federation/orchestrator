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

const external = (versions: SharedVersion[], dirty = false): SharedExternal => ({
  dirty,
  versions,
});

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

  const namesOf = (external: SharedExternal, action: SharedVersion['action']): string[] =>
    external.versions
      .filter(v => v.action === action)
      .flatMap(v => v.remotes.map(r => r.name))
      .sort();

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
      config.feature.useAutoExternalPooling = true;
      givenExternals({
        '@framework/core': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
        '@framework/common': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('is a no-op for a single-member pool', async () => {
      config.feature.useAutoExternalPooling = true;
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
      config.feature.useAutoExternalPooling = true;
      adapters.sharedExternalsRepo.getScopes = vi.fn(() => ['strict']);
      adapters.sharedExternalsRepo.scopeType = vi.fn(() => 'strict' as const);

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });
  });

  describe('has-pool early-out', () => {
    it('skips the scope walk entirely when auto-pooling is off and no pool tag was seen', async () => {
      config.feature.useAutoExternalPooling = false;
      adapters.sharedExternalsRepo.hasPoolTag = vi.fn(() => false);

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.getScopes).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('still pools when a pool tag was seen even with auto-pooling off', async () => {
      config.feature.useAutoExternalPooling = false;
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
      expect(namesOf(rebuiltFor('foo')!, 'share')).toEqual(['mfe1', 'mfe2']);
    });

    it('never early-outs when auto-pooling is on, regardless of the pool-tag memo', async () => {
      config.feature.useAutoExternalPooling = true;
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

      expect(namesOf(rebuiltFor('foo')!, 'share')).toEqual(['mfe1', 'mfe2']);
      expect(namesOf(rebuiltFor('bar')!, 'share')).toEqual(['mfe1', 'mfe2']);
    });
  });

  describe('defers to the base resolver for compatible families', () => {
    it('keeps every member shared, no scoping, when nothing is incompatible', async () => {
      config.feature.useAutoExternalPooling = true;
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
        '@framework/common': external([
          sharedVersion('17', [meta('mfe2'), meta('mfe1')], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      const core = rebuiltFor('@framework/core')!;
      const common = rebuiltFor('@framework/common')!;
      expect(namesOf(core, 'share')).toEqual(['mfe1', 'mfe2']);
      expect(namesOf(common, 'share')).toEqual(['mfe1', 'mfe2']);
      expect(core.versions.some(v => v.action === 'scope')).toBe(false);
      expect(common.versions.some(v => v.action === 'scope')).toBe(false);
    });

    it('leaves a single-provider member shared instead of scoping it (no anchor coverage penalty)', async () => {
      config.feature.useAutoExternalPooling = true;
      // m2 is provided by Q alone. Under the old anchor model an anchor that lacked m2 orphaned it;
      // now a compatible single-provider member simply stays shared.
      givenExternals({
        '@pool/m1': external([
          sharedVersion('1', [meta('P', { req: '1' }), meta('Q', { req: '1' })], {
            action: 'share',
          }),
        ]),
        '@pool/m2': external([sharedVersion('1', [meta('Q', { req: '1' })], { action: 'share' })]),
      });

      await poolSharedExternals();

      expect(namesOf(rebuiltFor('@pool/m1')!, 'share')).toEqual(['P', 'Q']);
      const m2 = rebuiltFor('@pool/m2')!;
      expect(namesOf(m2, 'share')).toEqual(['Q']);
      expect(m2.versions.some(v => v.action === 'scope')).toBe(false);
    });

    it('preserves the base resolver host winner', async () => {
      config.feature.useAutoExternalPooling = true;
      const build = () =>
        external([
          sharedVersion('17', [meta('host')], { host: true, action: 'share' }),
          sharedVersion('18', [meta('mfe1', { req: '18' })]),
        ]);
      givenExternals({ '@framework/core': build(), '@framework/common': build() });

      await poolSharedExternals();

      const share = rebuiltFor('@framework/core')!.versions.find(v => v.action === 'share')!;
      expect(share.host).toBe(true);
      expect(share.remotes[0]!.name).toBe('host');
    });

    it('reads determine actions without calling versionCheck.isCompatible', async () => {
      config.feature.useAutoExternalPooling = true;
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
      config.feature.useAutoExternalPooling = true;
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

    it('groups scope versions by each remote real tag (F3)', async () => {
      config.feature.useAutoExternalPooling = true;
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
      config.feature.useAutoExternalPooling = true;
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
    it('warns when a scoped-only member lost sharing across more than one consumer', async () => {
      config.feature.useAutoExternalPooling = true;
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

      expect(config.log.warn).toHaveBeenCalledWith(
        3,
        expect.stringContaining("'@framework/cdk' is scoped-only")
      );
    });

    it('stays silent for a single-consumer scoped-only member', async () => {
      config.feature.useAutoExternalPooling = true;
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
      config.feature.useAutoExternalPooling = true;
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
      config.feature.useAutoExternalPooling = true;
      config.strict.strictExternalCompatibility = true;
      givenExternals({
        '@framework/core': external([
          sharedVersion('17', [meta('a'), meta('b')], { action: 'share' }),
        ]),
        '@framework/common': external([sharedVersion('17', [meta('a')], { action: 'share' })]),
        '@framework/cdk': external([sharedVersion('17', [meta('b')], { action: 'share' })]),
      });

      await expect(poolSharedExternals()).resolves.toBeUndefined();

      expect(namesOf(rebuiltFor('@framework/core')!, 'share')).toEqual(['a', 'b']);
      expect(namesOf(rebuiltFor('@framework/cdk')!, 'share')).toEqual(['b']);
    });

    it('throws under strictExternalCompatibility when a remote is islanded', async () => {
      config.feature.useAutoExternalPooling = true;
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
});
