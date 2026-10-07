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
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';

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
    // Real semver: the gate's newest-first record order and its v-prefixed tags go through it too.
    adapters.versionCheck = createVersionCheck();
    poolDynamicExternals = createPoolDynamicExternals(config, adapters);
  });

  const writes = () => vi.mocked(adapters.sharedExternalsRepo.addOrUpdate).mock.calls;

  // Last write wins: the name sync may write a member again after its verdict.
  const writtenFor = (name: string): SharedExternal | undefined =>
    writes()
      .filter(c => c[0] === name)
      .at(-1)?.[1];

  // Every verdict the record ends up holding: a scoped copy's `poolCause` and a redirected copy's
  // `servedBy`. Islands are read from here, not from the warnings.
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

  it('leaves a family that agrees with the committed map (all skip) untouched', async () => {
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
      '@framework/common': { action: 'skip', override: 'http://host/common.js' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      '@framework/core': { action: 'skip', override: 'http://host/core.js' },
      '@framework/common': { action: 'skip', override: 'http://host/common.js' },
    });
  });

  it('scopes the family when no committed build ships the combination it would be handed', async () => {
    // The capture's shape: forms@22.0.8 and forms/signals@21.2.18 are both committed, from two builds
    // that ship neither of the other's members. Nobody so far consumed both; this remote would be the one
    // to bridge them, running forms from one build and signals from another. Comparing the two committed
    // builds with each other would be version arithmetic; what counts is whether *any* build shipped the
    // pair, and none did.
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
    // mfe's ^22 rejects the committed signals@21.2.18, so this is a range rejection, not a missing
    // entrypoint: `incompatible` on every copy mfe holds.
    expect(verdictsWritten()).toEqual([
      'mfe@@framework/forms/signals: incompatible',
      'mfe@@framework/forms: incompatible',
    ]);
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
    // Its router@22.0.5 accepts the committed 22.1.0: what it lacks is forms, so the family is uncovered.
    expect(verdictsWritten()).toEqual([
      'mfe@@framework/forms: uncovered',
      'mfe@@framework/router: uncovered',
    ]);
  });

  it('accepts the committed tag as its own when its copy ships it v-prefixed, whatever its range', async () => {
    // A copy is never incompatible with its own version, compared by semver (`v17.0.0` is `17.0.0`).
    // mfe's ranges drifted to ~16 and exclude the committed 17.0.0, which is still its own build.
    const record = {
      '@framework/core': committed(
        '@framework/core',
        { tag: '17.0.0', remotes: ['team/a'] },
        { tag: 'v17.0.0', remotes: ['mfe'] }
      ),
      '@framework/common': committed(
        '@framework/common',
        { tag: '17.0.0', remotes: ['team/a'] },
        { tag: 'v17.0.0', remotes: ['mfe'] }
      ),
    };
    for (const external of Object.values(record))
      external.versions[1]!.remotes[0]!.requiredVersion = '~16.0.0';
    givenCommitted(record);
    const entry = entryWith(shared('@framework/core'), shared('@framework/common'));
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'skip' },
      '@framework/common': { action: 'skip' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      '@framework/core': { action: 'skip' },
      '@framework/common': { action: 'skip' },
    });
    expect(verdictsWritten()).toEqual([]);
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
    // so mfe serves its own family instead. Both builds are mappable, so that rule alone refuses team/b.
    adapters.remoteInfoRepo.tryGet = vi.fn(name =>
      Optional.of({ scopeUrl: `http://${name.slice('team/'.length)}/`, exposes: [] } as RemoteInfo)
    );
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

  it('scopes patch drift across two committed builds that no build shipped together', async () => {
    // The committed map serves core@22.0.8 from team/a and cdk@22.0.6 from team/b; mfe imports both. The
    // two sit on one minor line, but no build shipped that pair, so mfe serves its own family and pays the
    // download. team/b runs no subpool either: it does not win core (constraint 9).
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
    // Its copies are the only ones: update-cache has recorded them, and the committed map serves nothing.
    givenCommitted({
      '@framework/core': committed('@framework/core', { tag: '17.0.0', remotes: ['mfe'] }),
      '@framework/common': committed('@framework/common', { tag: '17.0.0', remotes: ['mfe'] }),
    });
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

  it('passes actions through when the committed scope carries no pool state at all', async () => {
    // No `pool` tag or stored pool anywhere in the committed scope (unscoped packages carry no npm-scope
    // tag) → no pool, so update-cache's actions pass through even though the family is right there.
    const entry = entryWith(shared('foo'), shared('bar'));
    givenCommitted({
      foo: committed('foo', { tag: '17.0.0', remotes: ['host', 'mfe'] }),
      bar: committed('bar', { tag: '17.0.0', remotes: ['host', 'mfe'] }),
    });
    const actions: SharedInfoActions = {
      foo: { action: 'skip', override: 'http://host/foo.js' },
      bar: { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions).toEqual({
      foo: { action: 'skip', override: 'http://host/foo.js' },
      bar: { action: 'scope' },
    });
    expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
  });

  it('never pools the strict scope (an incompatible global sibling cannot island it)', async () => {
    // The strict scope is never pooled: a strict @framework/core must not be islanded by an
    // incompatible global sibling. mfe's common is 18, which the committed 17 rejects. The mocked
    // repository hands this record out for every scope, so pooling the strict scope would island core.
    const entry = entryWith(
      shared('@framework/core', { shareScope: 'strict' }),
      shared('@framework/common')
    );
    givenCommitted({
      '@framework/core': committed('@framework/core', { tag: '17.0.0', remotes: ['host', 'mfe'] }),
      '@framework/common': committed(
        '@framework/common',
        { tag: '17.0.0', remotes: ['host'] },
        { tag: '18.0.0', remotes: ['mfe'], action: 'scope' }
      ),
    });
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'share' },
      '@framework/common': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'share' });
    expect(result.actions['@framework/common']).toEqual({ action: 'scope' });
  });

  it('coordinates each shareScope independently (no cross-scope pooling)', async () => {
    // Same pool name but different scopes (core in team-a, common in global): they must not coordinate.
    // In global, common is 18 against the committed 17 and scopes; core, alone in team-a, is a lone tag
    // and passes through, where one cross-scope family would scope it too.
    const entry = entryWith(
      shared('@framework/core', { shareScope: 'team-a' }),
      shared('@framework/common')
    );
    const global = {
      '@framework/core': committed('@framework/core', { tag: '17.0.0', remotes: ['host'] }),
      '@framework/common': committed(
        '@framework/common',
        { tag: '17.0.0', remotes: ['host'] },
        { tag: '18.0.0', remotes: ['mfe'], action: 'scope' }
      ),
    };
    const teamA = {
      '@framework/core': committed('@framework/core', { tag: '17.0.0', remotes: ['mfe'] }),
    };
    tagStoredByNpmScope(global);
    tagStoredByNpmScope(teamA);
    adapters.sharedExternalsRepo.getFromScope = vi.fn(scope =>
      scope === 'team-a' ? teamA : global
    );
    const actions: SharedInfoActions = {
      '@framework/core': { action: 'share' },
      '@framework/common': { action: 'scope' },
    };

    const result = await poolDynamicExternals({ entry, actions });

    expect(result.actions['@framework/core']).toEqual({ action: 'share' });
    expect(result.actions['@framework/common']).toEqual({ action: 'scope' });
  });

  // The delta decides in `actions`; these pin that the record agrees, because a plain reload rebuilds the
  // map from the record alone. Before this, the record kept `update-cache`'s verdicts and a reload served
  // the combination the delta had refused (e2e/pooling/lifecycle.e2e.spec.ts, "the dynamic island").
  describe('verdicts in the record', () => {
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
      // The resolver scopes a copy only for a reason: here mfe ships common 18, whose range rejects the
      // shared 17. (A range rejecting its own tag would be no reason: a copy always accepts what it ships.)
      const common = committed(
        '@framework/common',
        { tag: '18.0.0', remotes: ['mfe'], action: 'scope' },
        { tag: '17.0.0', remotes: ['host'], action: 'share' }
      );
      // The init election's winner: the dynamic path never re-elects, so it must survive the write.
      givenCommitted({
        '@framework/core': {
          ...committed('@framework/core', { tag: '17.0.0', remotes: ['host', 'mfe'] }),
          poolWinner: 'host',
        },
        '@framework/common': { ...common, poolWinner: 'host' },
      });

      await poolDynamicExternals({
        entry,
        actions: {
          '@framework/core': { action: 'skip' },
          '@framework/common': { action: 'scope' },
        },
      });

      // Both members, the matching one included: the island is the whole family.
      expect(copies(writtenFor('@framework/core'))).toEqual([
        ['17.0.0:share', [{ name: 'host' }]],
        ['17.0.0:scope', [{ name: 'mfe', poolCause: 'incompatible' }]],
      ]);
      expect(copies(writtenFor('@framework/common'))).toEqual([
        ['18.0.0:scope', [{ name: 'mfe', poolCause: 'incompatible' }]],
        ['17.0.0:share', [{ name: 'host' }]],
      ]);
      for (const name of ['@framework/core', '@framework/common']) {
        expect(writtenFor(name)!.poolName).toBe('framework');
        expect(writtenFor(name)!.poolWinner).toBe('host');
      }
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
    });

    it('records a range rejection as incompatible, and drops a share only it provided', async () => {
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
