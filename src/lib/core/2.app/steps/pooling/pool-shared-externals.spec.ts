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
        '@angular/core': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
        '@angular/common': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('is a no-op for a single-remote pool', async () => {
      config.profile.useAutoExternalPooling = true;
      givenExternals({
        '@angular/core': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
        '@angular/common': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
      });

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('is a no-op for a single-member pool', async () => {
      config.profile.useAutoExternalPooling = true;
      givenExternals({
        '@angular/core': external([
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
        '@angular/core': external([
          sharedVersion('17', [meta('mfe1'), meta('mfe2')], { action: 'share' }),
        ]),
        // note: mfe2 listed first — pooling must re-point this to the mfe1 anchor.
        '@angular/common': external([
          sharedVersion('17', [meta('mfe2'), meta('mfe1')], { action: 'share' }),
        ]),
      });

      await poolSharedExternals();

      const core = rebuiltFor('@angular/core')!;
      const common = rebuiltFor('@angular/common')!;
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
      givenExternals({ '@angular/core': build(), '@angular/common': build() });

      await poolSharedExternals();

      const share = rebuiltFor('@angular/core')!.versions.find(v => v.action === 'share')!;
      expect(share.remotes[0]!.name).toBe('host');
    });
  });

  describe('all-or-nothing classification', () => {
    it('scopes a strict-incompatible remote entire family, others follow', async () => {
      config.profile.useAutoExternalPooling = true;
      adapters.versionCheck.isCompatible = vi.fn((tag, req) => tag === req);
      const build = () =>
        external([
          sharedVersion('17', [meta('mfe1', { req: '17' }), meta('mfe2', { req: '17' })], {
            action: 'share',
          }),
          sharedVersion('18', [meta('mfe3', { req: '18', strict: true })]),
        ]);
      givenExternals({ '@angular/core': build(), '@angular/common': build() });

      await poolSharedExternals();

      const core = rebuiltFor('@angular/core')!;
      const share = core.versions.find(v => v.action === 'share')!;
      const scope = core.versions.find(v => v.action === 'scope')!;
      expect(share.remotes.map(r => r.name)).toEqual(['mfe1', 'mfe2']);
      expect(scope.remotes.map(r => r.name)).toEqual(['mfe3']);

      // Family coherence: @angular/common lands its mfe3 family in scope too.
      const common = rebuiltFor('@angular/common')!;
      expect(common.versions.find(v => v.action === 'scope')!.remotes.map(r => r.name)).toEqual([
        'mfe3',
      ]);
    });
  });

  describe('no covering anchor', () => {
    const disjoint = () => ({
      '@angular/core': external([sharedVersion('17', [meta('mfe1')], { action: 'share' })]),
      '@angular/common': external([sharedVersion('17', [meta('mfe2')], { action: 'share' })]),
    });

    it('warns and leaves externals unpooled', async () => {
      config.profile.useAutoExternalPooling = true;
      givenExternals(disjoint());

      await poolSharedExternals();

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
      expect(config.log.warn).toHaveBeenCalled();
    });

    it('throws under strictImportMap', async () => {
      config.profile.useAutoExternalPooling = true;
      config.strict.strictImportMap = true;
      givenExternals(disjoint());

      await expect(poolSharedExternals()).rejects.toThrow(NFError);
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });
  });

  describe('strict compatibility', () => {
    it('throws under strictExternalCompatibility when the pool forces a remote to scope', async () => {
      config.profile.useAutoExternalPooling = true;
      config.strict.strictExternalCompatibility = true;
      adapters.versionCheck.isCompatible = vi.fn((tag, req) => tag === req);
      const build = () =>
        external([
          sharedVersion('17', [meta('mfe1', { req: '17' })], { action: 'share' }),
          sharedVersion('18', [meta('mfe2', { req: '18', strict: true })]),
        ]);
      givenExternals({ '@angular/core': build(), '@angular/common': build() });

      await expect(poolSharedExternals()).rejects.toThrow(NFError);
      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });
  });
});
