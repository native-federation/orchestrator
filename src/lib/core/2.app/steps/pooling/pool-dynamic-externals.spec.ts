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
import { Optional } from 'lib/utils/optional';
import type { RemoteInfo } from 'lib/core/1.domain';
import type { DrivingContract } from '../../driving-ports/driving.contract';

// A committed external: the first version is the `share` one, i.e. `remotes[0]` of it is the build
// serving that member. Later versions are copies other builds hold.
//
// `update-cache` runs before this step and commits the loaded remote's own copies too, so a fixture that
// leaves `mfe` out of the record models a state production cannot reach — and the gate reads what the
// remote imports off exactly those copies. Every portfolio below that expects a verdict lists `mfe`.
const committed = (
  name: string,
  ...versions: { tag: string; remotes: string[]; action?: SharedVersion['action'] }[]
): SharedExternal => ({
  dirty: false,
  versions: versions.map((v, i) => ({
    tag: v.tag,
    host: false,
    action: v.action ?? (i === 0 ? 'share' : 'skip'),
    remotes: v.remotes.map(remote =>
      mockVersionRemote(remote, name, { requiredVersion: `^${v.tag.split('.')[0]}.0.0` })
    ),
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

  // The `committed` helper derives every range from its own version tag, so "same major" is exactly the
  // acceptance a real portfolio has here — and the coverage gate needs it to be real, since an anchor that
  // offers a version the loaded remote rejects has to fail on versions rather than on coverage.
  const acceptsSameMajor = () =>
    vi.fn(
      (tag: string, range: string) => tag.split('.')[0] === range.replace(/^\^/, '').split('.')[0]
    );

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

  it('scopes the family when no committed build ships the combination it would be handed', async () => {
    // The capture's shape: forms@22.0.8 and forms/signals@21.2.18 are both committed, from two builds
    // that ship neither of the other's members. Nobody so far consumed both; this remote would be the one
    // to bridge them, running forms from one build and signals from another. The old gate compared the two
    // committed builds with each other, which is version arithmetic; the promise asks whether *any* build
    // shipped the pair, and none did.
    adapters.versionCheck.isCompatible = acceptsSameMajor();
    givenCommitted({
      '@framework/forms': committed(
        '@framework/forms',
        { tag: '22.0.8', remotes: ['team/a', 'mfe'] },
        { tag: '21.2.18', remotes: ['team/legacy'] }
      ),
      '@framework/forms/signals': committed(
        '@framework/forms/signals',
        { tag: '21.2.18', remotes: ['team/legacy'] },
        { tag: '22.0.8', remotes: ['mfe'] }
      ),
    });
    const entry = entryWith(shared('@framework/forms'), shared('@framework/forms/signals'));
    const actions: SharedInfoActions = {
      '@framework/forms': { action: 'skip' },
      '@framework/forms/signals': { action: 'skip' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/forms']).toEqual({ action: 'scope' });
    expect(result.actions['@framework/forms/signals']).toEqual({ action: 'scope' });
    // team/legacy comes closest — it is the one build carrying both members — and the reason it cannot
    // serve mfe is the version, not the coverage. Saying "an entrypoint is missing" here would send the
    // owner looking for the wrong thing.
    expect(config.log.warn).toHaveBeenCalledWith(
      8,
      expect.stringContaining(
        "'mfe' serves its own family: no committed build offers every entrypoint it imports at a version it accepts — '@framework/forms@21.2.18' is the gap, closest is 'team/legacy'."
      )
    );
  });

  it('dedups when a committed build did ship the whole combination', async () => {
    // The same shape with the bridge present: team/a ships both members at the tags the committed map
    // serves them at, so the combination mfe is handed is one a build compiled — provider identity is
    // irrelevant at equal versions — and mfe keeps both dedups, adding nothing to the map.
    givenCommitted({
      '@framework/forms': committed('@framework/forms', {
        tag: '22.0.8',
        remotes: ['team/a', 'mfe'],
      }),
      '@framework/forms/signals': committed('@framework/forms/signals', {
        tag: '22.0.8',
        remotes: ['team/a', 'mfe'],
      }),
    });
    const entry = entryWith(shared('@framework/forms'), shared('@framework/forms/signals'));
    const actions: SharedInfoActions = {
      '@framework/forms': { action: 'skip' },
      '@framework/forms/signals': { action: 'skip' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      '@framework/forms': { action: 'skip' },
      '@framework/forms/signals': { action: 'skip' },
    });
  });

  it('anchors onto a committed island and maps its files per consumer', async () => {
    // What lifting the override guard onto the global path buys. team/legacy is a committed island: every
    // copy it holds is scoped, so it demonstrably runs its own build and its files sit in the map under
    // its own scope. mfe ships the same previous-major family, which the committed 22 winner cannot serve,
    // so instead of downloading its own it takes legacy's — through a per-consumer override, because the
    // global `imports` names the 22 build.
    adapters.versionCheck.isCompatible = acceptsSameMajor();
    adapters.remoteInfoRepo.tryGet = vi.fn(name =>
      name === 'team/legacy'
        ? Optional.of({ scopeUrl: 'http://legacy/', exposes: [] } as RemoteInfo)
        : Optional.empty<RemoteInfo>()
    );
    // The committed map serves core from team/a and cdk from team/b, so nothing witnesses the pair mfe
    // would be handed — the only build carrying both is the island.
    givenCommitted({
      '@framework/core': committed(
        '@framework/core',
        { tag: '22.0.8', remotes: ['team/a'] },
        { tag: '21.2.18', remotes: ['team/legacy'], action: 'scope' },
        { tag: '21.2.18', remotes: ['mfe'] }
      ),
      '@framework/cdk': committed(
        '@framework/cdk',
        { tag: '22.0.6', remotes: ['team/b'] },
        { tag: '21.2.18', remotes: ['team/legacy'], action: 'scope' },
        { tag: '21.2.18', remotes: ['mfe'] }
      ),
    });
    const entry = entryWith(shared('@framework/core'), shared('@framework/cdk'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip' },
      '@framework/cdk': { action: 'skip' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({
      action: 'skip',
      covered: ['@framework/core'],
      override: { '@framework/core': 'http://legacy/@framework/core.js' },
    });
    expect(result.actions['@framework/cdk']).toEqual({
      action: 'skip',
      covered: ['@framework/cdk'],
      override: { '@framework/cdk': 'http://legacy/@framework/cdk.js' },
    });
    expect(config.log.warn).not.toHaveBeenCalled();
  });

  it('refuses to anchor onto a build that is itself deduping', async () => {
    // Constraint 9. team/b covers mfe and its versions fit, but it does not win `@framework/core`: its own
    // family resolves through the committed 22.0.8 winner, so its modules are already bound to that copy.
    // A consumer deduping onto it would inherit the tear one hop in, and no additive map can repair it —
    // so mfe serves its own family instead.
    adapters.versionCheck.isCompatible = vi.fn(() => true);
    givenCommitted({
      '@framework/core': committed(
        '@framework/core',
        { tag: '22.0.8', remotes: ['team/a'] },
        { tag: '22.0.6', remotes: ['team/b', 'mfe'] }
      ),
      '@framework/cdk': committed('@framework/cdk', {
        tag: '22.0.6',
        remotes: ['team/b', 'mfe'],
      }),
    });
    const entry = entryWith(shared('@framework/core'), shared('@framework/cdk'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip' },
      '@framework/cdk': { action: 'skip' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'scope' });
    expect(result.actions['@framework/cdk']).toEqual({ action: 'scope' });
  });

  it('scopes patch drift across two committed builds, which the old gate deduped', async () => {
    // Rewritten for the promise. The committed map serves core@22.0.8 from team/a and cdk@22.0.6 from
    // team/b; mfe imports both. The old gate deduped it because 22.0.8 and 22.0.6 sit on one minor line —
    // benign drift by construction. No build shipped that pair, so mfe serves its own family and pays the
    // download. team/b is not an anchor either: it does not win core (constraint 9).
    adapters.versionCheck.isCompatible = vi.fn(() => true);
    givenCommitted({
      '@framework/core': committed(
        '@framework/core',
        { tag: '22.0.8', remotes: ['team/a'] },
        { tag: '22.0.6', remotes: ['team/b'] },
        { tag: '22.0.5', remotes: ['mfe'] }
      ),
      '@framework/cdk': committed(
        '@framework/cdk',
        { tag: '22.0.6', remotes: ['team/b'] },
        { tag: '22.0.5', remotes: ['mfe'] }
      ),
    });
    const entry = entryWith(shared('@framework/core'), shared('@framework/cdk'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip' },
      '@framework/cdk': { action: 'skip' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'scope' });
    expect(result.actions['@framework/cdk']).toEqual({ action: 'scope' });
  });

  it('never mutates a committed version, whatever it decides', async () => {
    const externals = {
      '@framework/forms': committed(
        '@framework/forms',
        { tag: '22.0.8', remotes: ['team/a', 'mfe'] },
        { tag: '21.2.18', remotes: ['team/legacy'] }
      ),
      '@framework/forms/signals': committed(
        '@framework/forms/signals',
        { tag: '21.2.18', remotes: ['team/legacy'] },
        { tag: '22.0.8', remotes: ['mfe'] }
      ),
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
