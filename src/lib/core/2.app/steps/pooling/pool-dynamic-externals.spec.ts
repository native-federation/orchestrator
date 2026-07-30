import type { ForPoolingDynamicExternals } from '../../driver-ports/init/for-pooling-dynamic-externals.port';
import { createPoolDynamicExternals } from './pool-dynamic-externals';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import type {
  RemoteEntry,
  SharedExternal,
  SharedInfo,
  SharedInfoActions,
  SharedVersion,
} from 'lib/core/1.domain';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import type { DrivingContract } from '../../driving-ports/driving.contract';

// A committed external: the first version is the `share` one, i.e. `remotes[0]` of it is the build
// serving that member. Later versions are copies other builds hold.
const committed = (
  name: string,
  ...versions: { tag: string; remote: string; action?: SharedVersion['action'] }[]
): SharedExternal => ({
  dirty: false,
  versions: versions.map((v, i) => ({
    tag: v.tag,
    host: false,
    action: v.action ?? (i === 0 ? 'share' : 'skip'),
    remotes: [
      mockVersionRemote(v.remote, name, { requiredVersion: `^${v.tag.split('.')[0]}.0.0` }),
    ],
  })),
});

const shared = (name: string, opt: { pool?: string; shareScope?: string } = {}): SharedInfo =>
  mockSharedInfo(name, {
    requiredVersion: '^17.0.0',
    singleton: true,
    pool: opt.pool,
    shareScope: opt.shareScope,
  });

const entryWith = (...externals: SharedInfo[]): RemoteEntry =>
  ({
    name: 'mfe',
    url: 'http://mfe/remoteEntry.json',
    exposes: [],
    shared: externals,
  }) as RemoteEntry;

describe('createPoolDynamicExternals', () => {
  let poolDynamicExternals: ForPoolingDynamicExternals;
  let config: ConfigContract;
  let adapters: DrivingContract;

  const givenCommitted = (externals: Record<string, SharedExternal>) => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => externals);
  };

  beforeEach(() => {
    config = mockConfig();
    config.feature.useAutoExternalPooling = true;
    adapters = mockAdapters();
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({}));
    poolDynamicExternals = createPoolDynamicExternals(config, adapters);
  });

  it('leaves an all-compatible (all skip) family untouched', async () => {
    const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip', override: 'http://host/core.js' },
      '@framework/common': { action: 'skip', override: 'http://host/common.js' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      '@framework/core': { action: 'skip', override: 'http://host/core.js' },
      '@framework/common': { action: 'skip', override: 'http://host/common.js' },
    });
  });

  it('forces the whole family to scope when one member is incompatible', async () => {
    const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip', override: 'http://host/core.js' },
      '@framework/common': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'scope' });
    expect(result.actions['@framework/common']).toEqual({ action: 'scope' });
  });

  it('defers a share+skip mix (coverage gap, not a conflict): every member keeps its verdict', async () => {
    // No member is `scope`, so this is coverage, not incompatibility — the loaded remote follows.
    const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip', override: 'http://host/core.js' },
      '@framework/common': { action: 'share' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({
      action: 'skip',
      override: 'http://host/core.js',
    });
    expect(result.actions['@framework/common']).toEqual({ action: 'share' });
  });

  it('incompatibility-forced: scopes the whole family with no dedup, even the same-version member', async () => {
    // One member is `scope`, so the WHOLE family scopes — the same-version `skip` member does NOT
    // dedup (that would bridge the incompatible build via a shared intermediary).
    const entry = entryWith(
      shared('@framework/core'),
      shared('@framework/common'),
      shared('@framework/cdk')
    );
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip', override: 'http://host/core.js' },
      '@framework/common': { action: 'share' },
      '@framework/cdk': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'scope' });
    expect(result.actions['@framework/common']).toEqual({ action: 'scope' });
    expect(result.actions['@framework/cdk']).toEqual({ action: 'scope' });
  });

  it('scopes the family when the committed builds it would dedup onto disagree', async () => {
    // The capture's shape: forms@22.0.8 and forms/signals@21.2.18 are both committed, from builds
    // that disagree. Nobody so far consumed both; this remote would be the one to bridge them.
    givenCommitted({
      '@framework/forms': committed(
        '@framework/forms',
        { tag: '22.0.8', remote: 'team/a' },
        { tag: '21.2.18', remote: 'team/legacy' }
      ),
      '@framework/forms/signals': committed('@framework/forms/signals', {
        tag: '21.2.18',
        remote: 'team/legacy',
      }),
    });
    const entry = entryWith(shared('@framework/forms'), shared('@framework/forms/signals'));
    const actions: SharedInfoActions = {
      '@framework/forms': { action: 'skip', override: 'http://a/forms.js' },
      '@framework/forms/signals': { action: 'skip', override: 'http://legacy/signals.js' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/forms']).toEqual({ action: 'scope' });
    expect(result.actions['@framework/forms/signals']).toEqual({ action: 'scope' });
    expect(config.log.warn).toHaveBeenCalledWith(
      8,
      expect.stringContaining("disagree on '@framework/forms' (22.0.8 vs 21.2.18)")
    );
  });

  it('dedups onto committed builds that only drift by patch', async () => {
    givenCommitted({
      '@framework/core': committed(
        '@framework/core',
        { tag: '22.0.8', remote: 'team/a' },
        { tag: '22.0.6', remote: 'team/b' }
      ),
      '@framework/cdk': committed('@framework/cdk', { tag: '22.0.6', remote: 'team/b' }),
    });
    const entry = entryWith(shared('@framework/core'), shared('@framework/cdk'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip', override: 'http://a/core.js' },
      '@framework/cdk': { action: 'skip', override: 'http://b/cdk.js' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({
      action: 'skip',
      override: 'http://a/core.js',
    });
    expect(result.actions['@framework/cdk']).toEqual({
      action: 'skip',
      override: 'http://b/cdk.js',
    });
  });

  it('never mutates a committed version, whatever it decides', async () => {
    const externals = {
      '@framework/forms': committed(
        '@framework/forms',
        { tag: '22.0.8', remote: 'team/a' },
        { tag: '21.2.18', remote: 'team/legacy' }
      ),
      '@framework/forms/signals': committed('@framework/forms/signals', {
        tag: '21.2.18',
        remote: 'team/legacy',
      }),
    };
    givenCommitted(externals);
    const snapshot = JSON.stringify(externals);
    const entry = entryWith(shared('@framework/forms'), shared('@framework/forms/signals'));

    await poolDynamicExternals({
      entry,
      actions: {
        '@framework/forms': { action: 'skip' },
        '@framework/forms/signals': { action: 'skip' },
      },
    });

    expect(JSON.stringify(externals)).toBe(snapshot);
    expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
  });

  it('leaves a whole-pool-introducing remote (all share) untouched', async () => {
    const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'share' },
      '@framework/common': { action: 'share' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      '@framework/core': { action: 'share' },
      '@framework/common': { action: 'share' },
    });
  });

  it('does nothing when auto-pooling is off and there are no pool tags', async () => {
    config.feature.useAutoExternalPooling = false;
    const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip' },
      '@framework/common': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      '@framework/core': { action: 'skip' },
      '@framework/common': { action: 'scope' },
    });
  });

  it('bridges a cross-scope tagged sibling into the family via a co-tagged member', async () => {
    // The tag "framework" does not merge with the auto scope by name; ui joins only because
    // @framework/core is co-tagged, bridging the groups. ui is incompatible, so the family scopes.
    const entry = entryWith(
      shared('@framework/core', { pool: 'framework' }),
      shared('@design-system/ui', { pool: 'framework' })
    );
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip', override: 'http://host/core.js' },
      '@design-system/ui': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'scope' });
    expect(result.actions['@design-system/ui']).toEqual({ action: 'scope' });
  });

  it('does NOT bridge a tagged sibling without a co-tagged member (strict, no merge by name)', async () => {
    // ui tags "framework" but no framework member is co-tagged, so the label alone must not pull ui
    // into the auto-scoped family — ui keeps its own action.
    const entry = entryWith(
      shared('@framework/core'),
      shared('@framework/common'),
      shared('@design-system/ui', { pool: 'framework' })
    );
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip', override: 'http://host/core.js' },
      '@framework/common': { action: 'skip', override: 'http://host/common.js' },
      '@design-system/ui': { action: 'skip', override: 'http://host/ui.js' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@design-system/ui']).toEqual({
      action: 'skip',
      override: 'http://host/ui.js',
    });
  });

  it('pools via an explicit pool tag even when auto-pooling is off', async () => {
    config.feature.useAutoExternalPooling = false;
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
    // Auto-pooling off and no tag on the entry → no pool, so determine's actions pass through.
    config.feature.useAutoExternalPooling = false;
    const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip', override: 'http://host/core.js' },
      '@framework/common': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({
      action: 'skip',
      override: 'http://host/core.js',
    });
    expect(result.actions['@framework/common']).toEqual({ action: 'scope' });
  });

  it('never pools the strict scope (an incompatible global sibling cannot island it)', async () => {
    // The strict scope is never pooled: a strict @framework/core must not be islanded by an
    // incompatible global sibling.
    const entry = entryWith(
      shared('@framework/core', { shareScope: 'strict' }),
      shared('@framework/common')
    );
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'share' },
      '@framework/common': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'share' });
    expect(result.actions['@framework/common']).toEqual({ action: 'scope' });
  });

  it('coordinates each shareScope independently (no cross-scope pooling)', async () => {
    // Same pool name but different scopes (core in team-a, common in global): they must not
    // coordinate — each is a single-member pool, so both pass through.
    const entry = entryWith(
      shared('@framework/core', { shareScope: 'team-a' }),
      shared('@framework/common')
    );
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'share' },
      '@framework/common': { action: 'skip', override: 'http://host/common.js' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'share' });
    expect(result.actions['@framework/common']).toEqual({
      action: 'skip',
      override: 'http://host/common.js',
    });
  });
});
