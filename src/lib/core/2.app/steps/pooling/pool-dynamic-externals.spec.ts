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
import { tagStoredByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';
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
  ...versions: {
    tag: string;
    remotes: string[];
    action?: SharedVersion['action'];
    // `store-remote-entry` persists a declared `pool` onto the copy, so the committed record is where
    // membership is read from — a tag on somebody else's copy groups this family for the whole portfolio.
    pool?: string;
  }[]
): SharedExternal => ({
  dirty: false,
  versions: versions.map((v, i) => ({
    tag: v.tag,
    host: false,
    action: v.action ?? (i === 0 ? 'share' : 'skip'),
    remotes: v.remotes.map(remote =>
      mockVersionRemote(remote, name, {
        requiredVersion: `^${v.tag.split('.')[0]}.0.0`,
        pool: v.pool,
      })
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
  // acceptance a real portfolio has here — and the coverage gate needs it to be real, since a subpool build
  // that offers a version the loaded remote rejects has to fail on versions rather than on coverage.
  const acceptsSameMajor = () =>
    vi.fn(
      (tag: string, range: string) => tag.split('.')[0] === range.replace(/^\^/, '').split('.')[0]
    );

  // Scoped packages are tagged by their npm scope, as the build tags them by default; explicit tags win.
  const givenCommitted = (externals: Record<string, SharedExternal>) => {
    // Tagged up front, so a spec snapshotting `externals` sees the record as the step reads it.
    tagStoredByNpmScope(externals);
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => externals);
  };

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({}));
    // The decision asks every range whether it takes what the committed map serves.
    adapters.versionCheck.isCompatible = acceptsSameMajor();
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
    givenCommitted({
      '@framework/core': committed('@framework/core', { tag: '17.0.0', remotes: ['host', 'mfe'] }),
      '@framework/common': committed('@framework/common', {
        tag: '17.0.0',
        remotes: ['host', 'mfe'],
      }),
    });
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
    givenCommitted({
      '@framework/core': committed('@framework/core', { tag: '17.0.0', remotes: ['host', 'mfe'] }),
      '@framework/common': committed('@framework/common', {
        tag: '17.0.0',
        remotes: ['host', 'mfe'],
      }),
      '@framework/cdk': committed('@framework/cdk', { tag: '17.0.0', remotes: ['host', 'mfe'] }),
    });
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
    // mfe's ^22 rejects the committed signals@21.2.18, so this is a range rejection — `incompatible`, warned
    // in the init sentence so `nf.islands()` sees runtime islands too — not a missing entrypoint.
    expect(config.log.warn).toHaveBeenCalledWith(
      8,
      "[__GLOBAL__] 'mfe' is islanded: its range rejects '@framework/forms/signals@21.2.18' of the committed map. All 2 members it imports are scoped for it."
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

  it("joins a committed island's subpool and maps its files per consumer", async () => {
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

  it('lets a remote that agrees with the committed map add the package it introduces', async () => {
    // mfe ships core at exactly the committed tag and cdk, which nobody committed. Agreeing, it takes the
    // global core and its own cdk is what the map adds: both actions stand.
    givenCommitted({
      '@framework/core': committed('@framework/core', {
        tag: '22.0.8',
        remotes: ['team/a', 'mfe'],
      }),
      '@framework/cdk': committed('@framework/cdk', { tag: '22.0.6', remotes: ['mfe'] }),
    });
    const entry = entryWith(shared('@framework/core'), shared('@framework/cdk'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip' },
      '@framework/cdk': { action: 'share' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      '@framework/core': { action: 'skip' },
      '@framework/cdk': { action: 'share' },
    });
    // Whatever is written names the pool; no copy of mfe carries a verdict.
    for (const [, written] of vi.mocked(adapters.sharedExternalsRepo.addOrUpdate).mock.calls)
      for (const version of written.versions)
        for (const meta of version.remotes.filter(r => r.name === 'mfe')) {
          expect(meta.servedBy).toBeUndefined();
          expect(meta.poolCause).toBeUndefined();
        }
  });

  it('does not let an entrypoint at another tag than its committed siblings agree', async () => {
    // Material ships entrypoints only, no root. The map serves `/sort` at 17.0.2; mfe introduces `/table` at
    // 17.0.0. Same package, so mfe disagrees: publishing its table would put two Material builds in the map.
    givenCommitted({
      '@framework/core': committed('@framework/core', {
        tag: '17.0.0',
        remotes: ['team/a', 'mfe'],
      }),
      '@framework/material/sort': committed('@framework/material/sort', {
        tag: '17.0.2',
        remotes: ['team/a'],
      }),
      '@framework/material/table': committed('@framework/material/table', {
        tag: '17.0.0',
        remotes: ['mfe'],
      }),
    });
    const entry = entryWith(shared('@framework/core'), shared('@framework/material/table'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip' },
      '@framework/material/table': { action: 'share' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'scope' });
    expect(result.actions['@framework/material/table']).toEqual({ action: 'scope' });
  });

  it('does not count its own new copies as served by the committed map', async () => {
    // update-cache has already recorded mfe's forms as a shared version, but the committed map holds no
    // forms at all. mfe also runs router@22.0.5 against the committed 22.1.0, so it cannot add forms beside
    // it either: forms is the gap, and mfe serves its own family.
    givenCommitted({
      '@framework/router': committed(
        '@framework/router',
        { tag: '22.1.0', remotes: ['team/a'] },
        { tag: '22.0.5', remotes: ['mfe'] }
      ),
      '@framework/forms': committed('@framework/forms', { tag: '22.0.5', remotes: ['mfe'] }),
    });
    const entry = entryWith(shared('@framework/router'), shared('@framework/forms'));
    const actions: SharedInfoActions = {
      '@framework/router': { action: 'skip' },
      '@framework/forms': { action: 'share' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/router']).toEqual({ action: 'scope' });
    expect(result.actions['@framework/forms']).toEqual({ action: 'scope' });
    expect(config.log.warn).toHaveBeenCalledWith(
      8,
      expect.stringContaining("'@framework/forms' is the gap")
    );
  });

  it("joins a committed subpool: its build's copies name itself and run its own family", async () => {
    // The committed map is 22; team/legacy-a runs a 21 subpool (its copies name it) with legacy-b in it.
    // mfe is 21 too, so it joins the subpool rather than downloading a third 21 build.
    adapters.remoteInfoRepo.tryGet = vi.fn(name =>
      name === 'team/legacy-a'
        ? Optional.of({ scopeUrl: 'http://legacy-a/', exposes: [] } as RemoteInfo)
        : Optional.empty<RemoteInfo>()
    );
    const record = {
      '@framework/core': committed(
        '@framework/core',
        { tag: '22.0.8', remotes: ['team/a'] },
        { tag: '21.2.18', remotes: ['team/legacy-a', 'mfe'] },
        { tag: '21.2.15', remotes: ['team/legacy-b'] }
      ),
      '@framework/router': committed(
        '@framework/router',
        { tag: '22.0.8', remotes: ['team/a'] },
        { tag: '21.2.18', remotes: ['team/legacy-a', 'mfe'] }
      ),
    };
    for (const external of Object.values(record))
      for (const version of external.versions)
        for (const meta of version.remotes)
          if (meta.name.startsWith('team/legacy')) meta.servedBy = 'team/legacy-a';
    givenCommitted(record);
    const entry = entryWith(shared('@framework/core'), shared('@framework/router'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip' },
      '@framework/router': { action: 'skip' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toMatchObject({
      action: 'skip',
      override: { '@framework/core': 'http://legacy-a/@framework/core.js' },
    });
    expect(result.actions['@framework/router']).toMatchObject({
      action: 'skip',
      override: { '@framework/router': 'http://legacy-a/@framework/router.js' },
    });
  });

  it("refuses to join a build's subpool when that build is itself deduping", async () => {
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
    // download. team/b runs no subpool either: it does not win core (constraint 9).
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

  it("never touches another remote's copy, whatever it decides", async () => {
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
    // Whatever it writes back is the loaded remote's own copies: every other remote's copy is exactly as
    // the committed map was built from it — same version, same action, same meta.
    const others = (external: SharedExternal) =>
      external.versions.flatMap(v =>
        v.remotes.filter(r => r.name !== 'mfe').map(r => ({ tag: v.tag, action: v.action, r }))
      );
    for (const [name, written] of vi.mocked(adapters.sharedExternalsRepo.addOrUpdate).mock.calls)
      expect(others(written)).toEqual(others(externals[name as keyof typeof externals]));
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

  it('does nothing when the committed record has no pools', async () => {
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
    // ui joins the family only because the same remote tags it with a member of it, bridging the
    // groups. ui is incompatible, so the family scopes.
    const entry = entryWith(
      shared('@framework/core', { pool: 'framework' }),
      shared('@design-system/ui', { pool: 'framework' })
    );
    givenCommitted({
      '@framework/core': committed('@framework/core', {
        tag: '17.0.0',
        remotes: ['mfe'],
        pool: 'framework',
      }),
      '@design-system/ui': committed('@design-system/ui', {
        tag: '17.0.0',
        remotes: ['mfe'],
        pool: 'framework',
      }),
    });
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip', override: 'http://host/core.js' },
      '@design-system/ui': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'scope' });
    expect(result.actions['@design-system/ui']).toEqual({ action: 'scope' });
  });

  it('pools unscoped packages through an explicit pool tag', async () => {
    const entry = entryWith(shared('foo', { pool: 'grp' }), shared('bar', { pool: 'grp' }));
    givenCommitted({
      foo: committed('foo', { tag: '17.0.0', remotes: ['mfe'], pool: 'grp' }),
      bar: committed('bar', { tag: '17.0.0', remotes: ['mfe'], pool: 'grp' }),
    });
    const actions: SharedInfoActions = {
      foo: { action: 'skip', override: 'http://host/foo.js' },
      bar: { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions.foo).toEqual({ action: 'scope' });
    expect(result.actions.bar).toEqual({ action: 'scope' });
  });

  it('has-pool early-out: nothing pools when the scope carries no pool state at all', async () => {
    // No `pool` tag or stored pool anywhere in the committed scope → no pool, so determine's actions pass
    // through even though the family is right there in the record.
    adapters.sharedExternalsRepo.hasPoolState = vi.fn(() => false);
    const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
    givenCommitted({
      '@framework/core': committed('@framework/core', { tag: '17.0.0', remotes: ['host', 'mfe'] }),
      '@framework/common': committed('@framework/common', {
        tag: '17.0.0',
        remotes: ['host', 'mfe'],
      }),
    });
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
    expect(adapters.sharedExternalsRepo.getFromScope).not.toHaveBeenCalled();
  });

  it('subjects an untagged entry to a pool another remote tagged', async () => {
    // The dynamic counterpart of "one remote declaring this is enough for the whole portfolio". `team/a`
    // tagged the lockstep pair at init; this entry declares neither tag nor a shared npm scope, and is
    // still subject to the family's coherence rules — previously it slipped through untouched and could
    // bridge two builds the portfolio had deliberately pooled apart.
    const entry = entryWith(shared('foo'), shared('bar'));
    givenCommitted({
      foo: committed('foo', { tag: '17.0.0', remotes: ['team/a', 'mfe'], pool: 'grp' }),
      bar: committed('bar', { tag: '17.0.0', remotes: ['team/a', 'mfe'], pool: 'grp' }),
    });
    const actions: SharedInfoActions = {
      foo: { action: 'skip', override: 'http://host/foo.js' },
      bar: { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions.foo).toEqual({ action: 'scope' });
    expect(result.actions.bar).toEqual({ action: 'scope' });
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

  // The delta decides in `actions`; these pin that the record agrees, because a plain reload rebuilds the
  // map from the record alone. Before this, the record kept `update-cache`'s verdicts and a reload served
  // the combination the delta had refused (e2e/pooling/lifecycle.e2e.spec.ts, "the dynamic island").
  describe('verdicts in the record', () => {
    // The mock's `compare` ties everything; the record is written newest first, as `commit()` does.
    beforeEach(() => {
      adapters.versionCheck.compare = vi.fn((a: string, b: string) =>
        a.localeCompare(b, undefined, { numeric: true })
      );
    });

    // Last write wins: the name sync may write a member again after its verdict.
    const writtenFor = (name: string): SharedExternal | undefined =>
      vi
        .mocked(adapters.sharedExternalsRepo.addOrUpdate)
        .mock.calls.filter(c => c[0] === name)
        .at(-1)?.[1];

    const copies = (external: SharedExternal | undefined) =>
      (external?.versions ?? []).map(v => [
        `${v.tag}:${v.action}`,
        v.remotes.map(r => ({
          name: r.name,
          ...(r.poolCause && { poolCause: r.poolCause }),
          ...(r.servedBy && { servedBy: r.servedBy }),
        })),
      ]);

    it('moves an islanded remote out of the shared version into a scope version', async () => {
      const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
      const common = committed('@framework/common', { tag: '17.0.0', remotes: ['host', 'mfe'] });
      // The resolver scopes a copy only for a reason: here mfe's strict common range rejects the shared 17.
      common.versions[0]!.remotes[1]!.requiredVersion = '^18.0.0';
      givenCommitted({
        '@framework/core': committed('@framework/core', {
          tag: '17.0.0',
          remotes: ['host', 'mfe'],
        }),
        '@framework/common': common,
      });

      await poolDynamicExternals({
        entry,
        actions: {
          '@framework/core': { action: 'skip' },
          '@framework/common': { action: 'scope' },
        },
      });

      // Both members, the matching one included: the island is the whole family.
      for (const name of ['@framework/core', '@framework/common']) {
        expect(copies(writtenFor(name))).toEqual([
          ['17.0.0:share', [{ name: 'host' }]],
          ['17.0.0:scope', [{ name: 'mfe', poolCause: 'incompatible' }]],
        ]);
        expect(writtenFor(name)!.poolName).toBe('framework');
      }
      expect(config.log.warn).toHaveBeenCalledWith(
        8,
        expect.stringContaining("'mfe' is islanded: its range rejects '@framework/common@17.0.0'")
      );
    });

    it("records a resolver scope for a missing entrypoint as 'uncovered', not a range rejection", async () => {
      // Under `scopeUncoveredEntrypoints` the resolver scopes mfe's common@17.0.1: its `/http` entrypoint is
      // not in the committed 17.0.0, though its range takes 17.0.0. The family self-serves for coverage.
      const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
      const common = committed('@framework/common', { tag: '17.0.0', remotes: ['host'] });
      common.versions.push({
        tag: '17.0.1',
        host: false,
        action: 'scope',
        remotes: [
          mockVersionRemote('mfe', '@framework/common', {
            requiredVersion: '^17.0.0',
            entries: {
              '@framework/common': 'common.js',
              '@framework/common/http': 'http.js',
            },
          }),
        ],
      });
      givenCommitted({
        '@framework/core': committed('@framework/core', {
          tag: '17.0.0',
          remotes: ['host', 'mfe'],
        }),
        '@framework/common': common,
      });

      await poolDynamicExternals({
        entry,
        actions: {
          '@framework/core': { action: 'skip' },
          '@framework/common': { action: 'scope' },
        },
      });

      expect(copies(writtenFor('@framework/core'))).toEqual([
        ['17.0.0:share', [{ name: 'host' }]],
        ['17.0.0:scope', [{ name: 'mfe', poolCause: 'uncovered' }]],
      ]);
      expect(config.log.warn).toHaveBeenCalledWith(
        8,
        expect.stringContaining("'mfe' serves its own family")
      );
      expect(config.log.warn).toHaveBeenCalledWith(
        8,
        expect.stringContaining("'@framework/common/http' is the gap")
      );
    });

    it('records a range rejection as incompatible, and drops a share only it provided', async () => {
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
        // `update-cache` made mfe the sole provider of a member nobody had shared yet.
        '@framework/animations': committed('@framework/animations', {
          tag: '22.0.8',
          remotes: ['mfe'],
        }),
      });
      const entry = entryWith(
        shared('@framework/forms'),
        shared('@framework/forms/signals'),
        shared('@framework/animations')
      );

      await poolDynamicExternals({
        entry,
        actions: {
          '@framework/forms': { action: 'skip' },
          '@framework/forms/signals': { action: 'skip' },
          '@framework/animations': { action: 'share' },
        },
      });

      // mfe's ^22 rejects the committed signals@21.2.18: a range rejection, so `incompatible`.
      expect(copies(writtenFor('@framework/forms'))).toEqual([
        ['22.0.8:share', [{ name: 'team/a' }]],
        ['22.0.8:scope', [{ name: 'mfe', poolCause: 'incompatible' }]],
        ['21.2.18:skip', [{ name: 'team/legacy' }]],
      ]);
      expect(copies(writtenFor('@framework/forms/signals'))).toEqual([
        ['22.0.8:scope', [{ name: 'mfe', poolCause: 'incompatible' }]],
        ['21.2.18:share', [{ name: 'team/legacy' }]],
      ]);
      // The delta never published it globally, so the record must not either: it is scope-only now.
      expect(copies(writtenFor('@framework/animations'))).toEqual([
        ['22.0.8:scope', [{ name: 'mfe', poolCause: 'incompatible' }]],
      ]);
    });

    it('records the subpool build a redirected copy dedups onto', async () => {
      adapters.versionCheck.isCompatible = acceptsSameMajor();
      adapters.remoteInfoRepo.tryGet = vi.fn(name =>
        name === 'team/legacy'
          ? Optional.of({ scopeUrl: 'http://legacy/', exposes: [] } as RemoteInfo)
          : Optional.empty<RemoteInfo>()
      );
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

      await poolDynamicExternals({
        entry,
        actions: { '@framework/core': { action: 'skip' }, '@framework/cdk': { action: 'skip' } },
      });

      expect(copies(writtenFor('@framework/core'))).toEqual([
        ['22.0.8:share', [{ name: 'team/a' }]],
        ['21.2.18:scope', [{ name: 'team/legacy' }]],
        ['21.2.18:skip', [{ name: 'mfe', servedBy: 'team/legacy' }]],
      ]);
      expect(writtenFor('@framework/cdk')!.versions[2]!.remotes[0]!.servedBy).toBe('team/legacy');
    });

    // The same portfolio with team/legacy gone from the remote cache. Its files cannot be mapped, so it is
    // no subpool to join: left on update-cache's actions, mfe would run a member from each build.
    it('serves the remote its whole family when the only fitting build is not in the cache', async () => {
      adapters.versionCheck.isCompatible = acceptsSameMajor();
      adapters.remoteInfoRepo.tryGet = vi.fn(() => Optional.empty<RemoteInfo>());
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
      const actions: SharedInfoActions = {
        '@framework/core': { action: 'skip' },
        '@framework/cdk': { action: 'skip' },
      };

      await poolDynamicExternals({
        entry: entryWith(shared('@framework/core'), shared('@framework/cdk')),
        actions,
      });

      expect(actions['@framework/core']!.action).toBe('scope');
      expect(actions['@framework/cdk']!.action).toBe('scope');
      expect(copies(writtenFor('@framework/core'))).toEqual([
        ['22.0.8:share', [{ name: 'team/a' }]],
        // Its cause stays why it missed the map (its ^21 rejects 22): the missing build only took away the fix.
        ['21.2.18:scope', [{ name: 'team/legacy' }, { name: 'mfe', poolCause: 'incompatible' }]],
      ]);
      expect(config.log.warn).toHaveBeenCalledWith(
        8,
        "[__GLOBAL__][mfe] 'team/legacy' is not in the cache, so its files cannot be mapped."
      );
    });

    it('writes no verdict for a witnessed remote', async () => {
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

      await poolDynamicExternals({
        entry,
        actions: {
          '@framework/forms': { action: 'skip' },
          '@framework/forms/signals': { action: 'skip' },
        },
      });

      // Only the name sync writes, onto the committed versions untouched.
      for (const [name, written] of vi.mocked(adapters.sharedExternalsRepo.addOrUpdate).mock.calls)
        expect(written.versions).toEqual(
          tagStoredByNpmScope({
            [name]: committed(name, { tag: '22.0.8', remotes: ['team/a', 'mfe'] }),
          })[name]!.versions
        );
    });
  });

  describe('pool names in the record', () => {
    const namesWritten = () =>
      Object.fromEntries(
        vi
          .mocked(adapters.sharedExternalsRepo.addOrUpdate)
          .mock.calls.map(([name, external]) => [name, external.poolName])
      );

    it('writes the committed pool name onto a member that has none', async () => {
      const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
      givenCommitted({
        '@framework/core': committed('@framework/core', {
          tag: '17.0.0',
          remotes: ['host', 'mfe'],
        }),
        '@framework/common': committed('@framework/common', {
          tag: '17.0.0',
          remotes: ['host', 'mfe'],
        }),
      });
      const actions: SharedInfoActions = {
        '@framework/core': { action: 'skip', override: 'http://host/core.js' },
        '@framework/common': { action: 'skip', override: 'http://host/common.js' },
      };

      const result = await poolDynamicExternals({ entry, actions });

      expect(namesWritten()).toEqual({
        '@framework/core': 'framework',
        '@framework/common': 'framework',
      });
      // Names only: the loaded remote's verdicts are untouched by the write.
      expect(result.actions['@framework/core']).toEqual({
        action: 'skip',
        override: 'http://host/core.js',
      });
    });

    it('writes nothing for a member already carrying its name', async () => {
      const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
      givenCommitted({
        '@framework/core': {
          ...committed('@framework/core', { tag: '17.0.0', remotes: ['host', 'mfe'] }),
          poolName: 'framework',
        },
        '@framework/common': {
          ...committed('@framework/common', { tag: '17.0.0', remotes: ['host', 'mfe'] }),
          poolName: 'framework',
        },
      });
      const actions: SharedInfoActions = {
        '@framework/core': { action: 'skip' },
        '@framework/common': { action: 'skip' },
      };

      await poolDynamicExternals({ entry, actions });

      expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
    });

    it('clears a stale pool name off an external that is in no pool any more', async () => {
      // `rxjs` is untagged and alone, yet the record still names a pool for it from an earlier portfolio.
      const entry = entryWith(shared('rxjs'));
      givenCommitted({
        rxjs: { ...committed('rxjs', { tag: '7.0.0', remotes: ['host', 'mfe'] }), poolName: 'old' },
      });

      await poolDynamicExternals({ entry, actions: { rxjs: { action: 'skip' } } });

      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledOnce();
      expect(namesWritten()).toEqual({ rxjs: undefined });
    });
  });
});
