import type { ForPoolingDynamicExternals } from '../../driver-ports/init/for-pooling-dynamic-externals.port';
import { createPoolDynamicExternals } from './pool-dynamic-externals';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import type { RemoteEntry, SharedInfo, SharedInfoActions } from 'lib/core/1.domain';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';

const shared = (name: string, opt: { pool?: string } = {}): SharedInfo =>
  mockSharedInfo(name, { requiredVersion: '^17.0.0', singleton: true, pool: opt.pool });

const entryWith = (...externals: SharedInfo[]): RemoteEntry =>
  ({ name: 'mfe', url: 'http://mfe/remoteEntry.json', exposes: [], shared: externals }) as RemoteEntry;

describe('createPoolDynamicExternals', () => {
  let poolDynamicExternals: ForPoolingDynamicExternals;
  let config: ConfigContract;

  beforeEach(() => {
    config = mockConfig();
    config.profile.useAutoExternalPooling = true;
    poolDynamicExternals = createPoolDynamicExternals(config);
  });

  it('leaves an all-compatible (all skip) family untouched', async () => {
    const entry = entryWith(shared('@angular/core'), shared('@angular/common'));
    const actions: SharedInfoActions = {
      '@angular/core': { action: 'skip', override: 'http://host/core.js' },
      '@angular/common': { action: 'skip', override: 'http://host/common.js' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      '@angular/core': { action: 'skip', override: 'http://host/core.js' },
      '@angular/common': { action: 'skip', override: 'http://host/common.js' },
    });
  });

  it('forces the whole family to scope when one member is incompatible', async () => {
    const entry = entryWith(shared('@angular/core'), shared('@angular/common'));
    const actions: SharedInfoActions = {
      '@angular/core': { action: 'skip', override: 'http://host/core.js' },
      '@angular/common': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@angular/core']).toEqual({ action: 'scope' });
    expect(result.actions['@angular/common']).toEqual({ action: 'scope' });
  });

  it('coverage-forced: scopes only the new-share member; the same-version skip member dedups', async () => {
    // No member is `scope` (no strict incompatibility), so this is coverage — not incompatibility.
    // @angular/common would introduce a new global share (impossible on the committed map) → scopes.
    // @angular/core is same-version as the committed build → stays skip (dedup, no extra download).
    const entry = entryWith(shared('@angular/core'), shared('@angular/common'));
    const actions: SharedInfoActions = {
      '@angular/core': { action: 'skip', override: 'http://host/core.js' },
      '@angular/common': { action: 'share' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@angular/core']).toEqual({ action: 'skip', override: 'http://host/core.js' });
    expect(result.actions['@angular/common']).toEqual({ action: 'scope' });
  });

  it('incompatibility-forced: scopes the whole family with no dedup, even the same-version member', async () => {
    // One member is strict-incompatible (`scope`), so the WHOLE family scopes — the same-version
    // `skip` member does NOT dedup (that would bridge the incompatible build via a shared intermediary).
    const entry = entryWith(shared('@angular/core'), shared('@angular/common'), shared('@angular/cdk'));
    const actions: SharedInfoActions = {
      '@angular/core': { action: 'skip', override: 'http://host/core.js' },
      '@angular/common': { action: 'share' },
      '@angular/cdk': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@angular/core']).toEqual({ action: 'scope' });
    expect(result.actions['@angular/common']).toEqual({ action: 'scope' });
    expect(result.actions['@angular/cdk']).toEqual({ action: 'scope' });
  });

  it('leaves a whole-pool-introducing remote (all share) untouched', async () => {
    const entry = entryWith(shared('@angular/core'), shared('@angular/common'));
    const actions: SharedInfoActions = {
      '@angular/core': { action: 'share' },
      '@angular/common': { action: 'share' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      '@angular/core': { action: 'share' },
      '@angular/common': { action: 'share' },
    });
  });

  it('does nothing when auto-pooling is off and there are no pool tags', async () => {
    config.profile.useAutoExternalPooling = false;
    const entry = entryWith(shared('@angular/core'), shared('@angular/common'));
    const actions: SharedInfoActions = {
      '@angular/core': { action: 'skip' },
      '@angular/common': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      '@angular/core': { action: 'skip' },
      '@angular/common': { action: 'scope' },
    });
  });

  it('pools via an explicit pool tag even when auto-pooling is off', async () => {
    config.profile.useAutoExternalPooling = false;
    const entry = entryWith(shared('foo', { pool: 'grp' }), shared('bar', { pool: 'grp' }));
    const actions: SharedInfoActions = {
      foo: { action: 'skip', override: 'http://host/foo.js' },
      bar: { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions.foo).toEqual({ action: 'scope' });
    expect(result.actions.bar).toEqual({ action: 'scope' });
  });

  it('has-pool early-out: an incompatible family is left untouched when auto-pooling is off and the entry has no pool tag', async () => {
    // Without the gate this family would coordinate; with auto-pooling off and no tag on the entry
    // there is no pool, so the actions determine produced must pass through unchanged.
    config.profile.useAutoExternalPooling = false;
    const entry = entryWith(shared('@angular/core'), shared('@angular/common'));
    const actions: SharedInfoActions = {
      '@angular/core': { action: 'skip', override: 'http://host/core.js' },
      '@angular/common': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@angular/core']).toEqual({
      action: 'skip',
      override: 'http://host/core.js',
    });
    expect(result.actions['@angular/common']).toEqual({ action: 'scope' });
  });
});
