import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockVersionRemote, newestFirst } from 'lib/testing/domain/externals/version.mock';
import { findIncoherentRemotes, findSplitRemotes } from 'lib/testing/pooling/no-tear';
import { Optional } from 'lib/utils/optional';
import type { RemoteInfo, SharedVersion } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createDetermineSharedExternals } from '../determine-shared-externals';
import { createMarkPoolsForReelection } from './mark-pools-for-reelection';
import { createPoolSharedExternals } from './pool-shared-externals';
import { createGenerateImportMap } from '../generate-import-map';
import { tagStoredByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';

/**
 * Found by the pooling property test. The init election publishes a package round 1 does not ship from
 * the builds that agree with it; before the witness rule it then moved every remote the extended coverage
 * served onto the global map, even one whose resolved combination no single build shipped.
 *
 * Shrunk from the property suite (POOLING_PROPERTY_SEED=1..3, SCALE=5); every range is the caret of its own
 * tag. r1 and r2's `^18.0.1` reject r0's 18.0.0, so r0's build serves only itself and no subpool forms; r1
 * wins round 1 with m0@18.0.1 (r2 agrees with it), and the extension publishes m1@18.0.1 from r2. r0's
 * `^18.0.0` accepts both 18.0.1s, so it used to resolve m0@18.0.1 + m1@18.0.1: a combination r1 (m0 only)
 * and r2 (m1 only) each ship half of, and no build ships whole.
 */
describe('pooling: the init extension only serves a witnessed combination', () => {
  const SCOPE = {
    'team/r0': 'http://r0/',
    'team/r1': 'http://r1/',
    'team/r2': 'http://r2/',
    'team/r3': 'http://r3/',
    'team/r4': 'http://r4/',
    'team/r5': 'http://r5/',
    'team/r6': 'http://r6/',
  } as const;
  const M0 = '@lib/m0';
  const M1 = '@lib/m1';

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-extension-witness'),
      clearStorage: true,
    });

    adapters.remoteInfoRepo.getAll = vi.fn(() => ({}));
    adapters.scopedExternalsRepo.getAll = vi.fn(() => ({}));
    adapters.sharedChunksRepo.tryGet = vi.fn(() => Optional.empty<string[]>());
    adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
      name in SCOPE
        ? Optional.of({ scopeUrl: SCOPE[name as keyof typeof SCOPE], exposes: [] } as RemoteInfo)
        : Optional.empty<RemoteInfo>()
    );
  });

  // Every range is the caret of its own tag unless `req` says otherwise; a host row lists the host first.
  const version = (
    tag: string,
    external: string,
    remotes: string[],
    o: { host?: boolean; req?: Record<string, string> } = {}
  ): SharedVersion => ({
    tag,
    host: o.host ?? false,
    action: 'skip',
    remotes: remotes.map(remote =>
      mockVersionRemote(remote, external, {
        requiredVersion: o.req?.[remote] ?? `^${tag}`,
        strictVersion: false,
      })
    ),
  });

  const seed = (name: string, versions: SharedVersion[]) =>
    adapters.sharedExternalsRepo.addOrUpdate(
      name,
      // `@lib/*` shares one npm-scope pool tag, as the build adds by default.
      tagStoredByNpmScope({
        [name]: { dirty: true, versions: newestFirst(versions, adapters.versionCheck.compare) },
      })[name]!,
      undefined
    );

  const runInit = async () => {
    const pooled = await createMarkPoolsForReelection(config, adapters)();
    const touched = await createDetermineSharedExternals(config, adapters)(pooled);
    await createPoolSharedExternals(config, adapters)(touched);
    return createGenerateImportMap(config, adapters)();
  };

  const stored = () => adapters.sharedExternalsRepo.getFromScope(undefined);

  const copyOf = (external: string, remote: string) =>
    stored()[external]!.versions.flatMap(v =>
      v.remotes.filter(r => r.name === remote).map(r => ({ ...r, action: v.action, tag: v.tag }))
    )[0]!;

  const noTear = (importMap: Awaited<ReturnType<typeof runInit>>) => {
    expect(findIncoherentRemotes({ importMap, members: stored(), scopeUrls: SCOPE })).toEqual([]);
    expect(findSplitRemotes({ importMap, members: stored(), scopeUrls: SCOPE })).toEqual([]);
  };

  const ownFiles = (remote: keyof typeof SCOPE) => ({
    [M0]: `${SCOPE[remote]}@lib/m0.js`,
    [M1]: `${SCOPE[remote]}@lib/m1.js`,
  });

  it('keeps a remote off the global map when the extended coverage would tear it', async () => {
    seed(M0, [version('18.0.0', M0, ['team/r0']), version('18.0.1', M0, ['team/r1'])]);
    seed(M1, [version('18.0.0', M1, ['team/r0']), version('18.0.1', M1, ['team/r2'])]);

    const importMap = await runInit();

    noTear(importMap);

    // r1 and r2 each resolve their one member at their own tag, so the global map stays m0 from r1 and
    // m1 from r2. r0 is the only remote that would take both, and no build witnesses that pair: it serves
    // its own family, every copy scoped as `uncovered` (it accepts every tag the map publishes).
    expect(importMap.imports).toEqual({
      [M0]: 'http://r1/@lib/m0.js',
      [M1]: 'http://r2/@lib/m1.js',
    });
    expect(importMap.scopes?.[SCOPE['team/r0']]).toEqual(ownFiles('team/r0'));
    for (const name of [M0, M1])
      expect(copyOf(name, 'team/r0')).toMatchObject({ action: 'scope', poolCause: 'uncovered' });
    // r0 accepts every tag the map serves, so the warning names the pair, not a version it rejects. The
    // "'<gap>' is the gap" tail is what e2e/harness/federation.ts `islands()` parses.
    expect(config.log.warn).toHaveBeenCalledWith(
      3,
      "[__GLOBAL__][pool:lib] 'team/r0' serves its own family: no build shipped '@lib/m0@18.0.1' together with '@lib/m1@18.0.1' — '@lib/m1' is the gap, closest is 'team/r1'. All 2 members it imports are scoped for it."
    );
  });

  // The positive control: an over-strict gate would still pass the case above. r1 is the host so it wins
  // round 1 although r3 serves everyone; otherwise r3 wins outright and the extension never runs. r3 runs a
  // subpool over r0 and r2 until the extension publishes m1@18.0.1, after which r3's own build witnesses
  // r0's pair: every remote moves onto the global map.
  it('moves a remote onto the global map when one build shipped its combination', async () => {
    seed(M0, [
      version('18.0.0', M0, ['team/r0'], { req: { 'team/r0': '^18.0.0' } }),
      version('18.0.1', M0, ['team/r1', 'team/r3'], { host: true }),
    ]);
    seed(M1, [
      version('18.0.0', M1, ['team/r0'], { req: { 'team/r0': '^18.0.0' } }),
      version('18.0.1', M1, ['team/r2', 'team/r3']),
    ]);

    const importMap = await runInit();

    noTear(importMap);
    expect(importMap.imports).toEqual({
      [M0]: 'http://r1/@lib/m0.js',
      [M1]: 'http://r2/@lib/m1.js',
    });
    expect(importMap.scopes ?? {}).toEqual({});
    for (const name of [M0, M1]) expect(copyOf(name, 'team/r0').poolCause).toBeUndefined();
  });

  // A subpool member the gate holds back. The host r1 wins round 1 with m0@18.0.1, r0 and r4 (one build)
  // form a subpool, and r2 contributes m1@18.0.1. r4 accepts both 18.0.1s but no build shipped them
  // together, so it stays in r0's subpool rather than moving — and the subpool keeps two members.
  it('keeps a subpool member in its subpool when the extended coverage is unwitnessed', async () => {
    const req = { 'team/r0': '^18.0.0', 'team/r4': '^18.0.0' };
    seed(M0, [
      version('18.0.0', M0, ['team/r0', 'team/r4'], { req }),
      version('18.0.1', M0, ['team/r1'], { host: true }),
    ]);
    seed(M1, [
      version('18.0.0', M1, ['team/r0', 'team/r4'], { req }),
      version('18.0.1', M1, ['team/r2']),
    ]);

    const importMap = await runInit();

    noTear(importMap);
    expect(importMap.imports).toEqual({
      [M0]: 'http://r1/@lib/m0.js',
      [M1]: 'http://r2/@lib/m1.js',
    });
    expect(importMap.scopes?.[SCOPE['team/r0']]).toEqual(ownFiles('team/r0'));
    expect(importMap.scopes?.[SCOPE['team/r4']]).toEqual(ownFiles('team/r0'));
    for (const name of [M0, M1]) {
      // A subpool is recorded as `servedBy` its build, the build's own copies included; neither carries a cause.
      for (const remote of ['team/r0', 'team/r4'])
        expect(copyOf(name, remote)).toMatchObject({ action: 'skip', servedBy: 'team/r0' });
    }
  });

  // A dissolving subpool's build the gate leaves alone. The host r1 ships m0@18.0.0; r5 (m0+m1@18.0.1)
  // runs a subpool over r6 (m1@18.0.1), winning the tie against r2's build on being newer — r2's exact
  // `18.0.0` keeps it out of r5's. The extension publishes r2's m1@18.0.0, which r6 shipped next to nothing
  // else, so r6 moves; r5 is left alone and would resolve m0@18.0.0 + m1@18.0.0, a pair no build shipped.
  it("leaves a dissolving subpool's build alone when the extended coverage is unwitnessed", async () => {
    seed(M0, [
      version('18.0.0', M0, ['team/r1'], { host: true }),
      version('18.0.1', M0, ['team/r5'], { req: { 'team/r5': '^18.0.0' } }),
    ]);
    seed(M1, [
      version('18.0.0', M1, ['team/r2'], { req: { 'team/r2': '18.0.0' } }),
      version('18.0.1', M1, ['team/r5', 'team/r6'], {
        req: { 'team/r5': '^18.0.0', 'team/r6': '^18.0.0' },
      }),
    ]);

    const importMap = await runInit();

    noTear(importMap);
    expect(importMap.imports).toEqual({
      [M0]: 'http://r1/@lib/m0.js',
      [M1]: 'http://r2/@lib/m1.js',
    });
    expect(importMap.scopes?.[SCOPE['team/r6']]).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/r5']]).toEqual(ownFiles('team/r5'));
    expect(copyOf(M1, 'team/r6').poolCause).toBeUndefined();
    for (const name of [M0, M1])
      expect(copyOf(name, 'team/r5')).toMatchObject({ action: 'scope', poolCause: 'uncovered' });
  });
});
