import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockVersionRemote, newestFirst } from 'lib/testing/domain/externals/version.mock';
import { Optional } from 'lib/utils/optional';
import {
  type RemoteEntry,
  type RemoteInfo,
  type SharedExternal,
  type SharedVersion,
} from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createDetermineSharedExternals } from '../determine-shared-externals';
import { createPoolSharedExternals } from './pool-shared-externals';
import { createGenerateImportMap } from '../generate-import-map';
import { createUpdateCache } from '../update-cache';
import { createPoolDynamicExternals } from './pool-dynamic-externals';
import { createConvertToImportMap } from '../convert-to-import-map';
import { committedView } from './anchoring';
import { findIncoherentRemotes } from 'lib/testing/pooling/no-tear';

/**
 * End-to-end coherence through determine → pooling → import map. Pooling does not make a family resolve
 * from one build — different members may legitimately be served from different remotes. What it
 * guarantees is that no single remote ends up drawing on builds that disagree: an incompatible or
 * disagreeing remote serves its whole `@framework/*` family from its own build, with no dedup, so a
 * foreign runtime cannot leak in through a shared sibling.
 *
 * Family coherence proper (the two #63 cases, patch-drift tolerance, asymmetric coverage) is locked in
 * `family-coherence.regression.spec.ts`.
 */
describe('pooling (integration)', () => {
  const SCOPE = {
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
    'team/mfe-c': 'http://mfe-c/',
    'team/mfe-d': 'http://mfe-d/',
  } as const;

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    config.feature.useAutoExternalPooling = true;

    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-pool-integration'),
      clearStorage: true,
    });

    adapters.remoteInfoRepo.getAll = vi.fn(() => ({}));
    adapters.scopedExternalsRepo.getAll = vi.fn(() => ({}));
    adapters.sharedChunksRepo.tryGet = vi.fn(() => Optional.empty());
    adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
      name in SCOPE
        ? Optional.of({ scopeUrl: SCOPE[name as keyof typeof SCOPE], exposes: [] } as RemoteInfo)
        : Optional.empty<RemoteInfo>()
    );
  });

  const meta = (remote: string, external: string, req: string) =>
    mockVersionRemote(remote, external, { requiredVersion: req, strictVersion: true });

  const version = (
    tag: string,
    external: string,
    remotes: { remote: string; req: string }[]
  ): SharedVersion => ({
    tag,
    host: false,
    action: 'skip',
    remotes: remotes.map(r => meta(r.remote, external, r.req)),
  });

  // Sorts like commit() does, so the fixtures below read in whatever order is clearest without
  // seeding an order production could never hand to determine.
  const seed = (name: string, versions: SharedVersion[]) =>
    adapters.sharedExternalsRepo.addOrUpdate(
      name,
      { dirty: true, versions: newestFirst(versions, adapters.versionCheck.compare) },
      undefined
    );

  // Threads determine's touched-externals signal into pooling exactly as init.flow does.
  // I3 holds for every fixture here too, so it is asserted centrally: no remote may resolve a combination
  // of tags that no single build shipped. None of these portfolios has a host.
  const runInit = async () => {
    const touched = await createDetermineSharedExternals(config, adapters)();
    await createPoolSharedExternals(config, adapters)(touched);
    const importMap = await createGenerateImportMap(config, adapters)();

    expect(
      findIncoherentRemotes({
        importMap,
        members: adapters.sharedExternalsRepo.getFromScope(undefined),
        scopeUrls: SCOPE,
      })
    ).toEqual([]);

    return importMap;
  };

  it('keeps an entire compatible @framework family on a single remote build', async () => {
    // Both remotes accept either tag, so both candidates cost one download and the tie breaks toward
    // the newest: mfe-b's 17.1.0 wins the whole family and mfe-a's older tag dedups onto it, so the
    // family stays single-source rather than splitting.
    seed('@framework/core', [
      version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@framework/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);
    seed('@framework/common', [
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);

    const importMap = await runInit();

    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-b']);
    expect(importMap.imports['@framework/common']).toContain(SCOPE['team/mfe-b']);
    expect(importMap.imports['@framework/common']).not.toContain(SCOPE['team/mfe-a']);
    // mfe-a dedups the whole family — no scoped copy of either member.
    expect(importMap.scopes?.[SCOPE['team/mfe-a']]).toBeUndefined();
  });

  it('scopes an incompatible remote whole family, keeping the global family single-source', async () => {
    seed('@framework/core', [
      version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@framework/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('18.0.0', '@framework/core', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);
    seed('@framework/common', [
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.1.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('18.0.0', '@framework/common', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);

    const importMap = await runInit();

    // Global family stays single-source (mfe-b, the newest of the two 17 builds), none of it served
    // from the incompatible mfe-c.
    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-b']);
    expect(importMap.imports['@framework/common']).toContain(SCOPE['team/mfe-b']);
    expect(importMap.imports['@framework/core']).not.toContain(SCOPE['team/mfe-c']);

    // mfe-c serves its own incompatible family from its own scope.
    const cScope = importMap.scopes?.[SCOPE['team/mfe-c']];
    expect(cScope?.['@framework/core']).toContain(SCOPE['team/mfe-c']);
    expect(cScope?.['@framework/common']).toContain(SCOPE['team/mfe-c']);
  });

  it('shares every member of a compatible ragged family, including a single-provider one', async () => {
    // Ragged portfolio, all on 17: mfe-a has core+common, mfe-b has common+forms. Nothing is
    // incompatible, so pooling defers to the base resolver — every member is shared, forms included.
    seed('@framework/core', [
      version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
    ]);
    seed('@framework/common', [
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);
    seed('@framework/forms', [
      version('17.0.0', '@framework/forms', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);

    const importMap = await runInit();

    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@framework/common']).toContain(SCOPE['team/mfe-a']);
    // mfe-b dedups common (same version) — no scoped re-download of it.
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@framework/common']).toBeUndefined();

    // forms is single-provider but compatible, so it is shared from mfe-b, not scoped-only.
    expect(importMap.imports['@framework/forms']).toContain(SCOPE['team/mfe-b']);
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@framework/forms']).toBeUndefined();
  });

  it('a tagged design system scopes its whole family for an incompatible consumer (no foreign framework runtime)', async () => {
    // ui joins the framework family via the co-tagged bridge member @framework/core (membership is by
    // shared member, not by name). Neither core build can serve the other remote, so the tie breaks
    // toward the newest and mfe-a@18 anchors the family. mfe-b runs framework 17, incompatible with
    // that anchor, so it scopes its ENTIRE family — ui included, with NO dedup — so no second
    // framework runtime leaks in through the shared design system.
    const tagged = (remote: string, external: string, req: string) =>
      mockVersionRemote(remote, external, {
        requiredVersion: req,
        strictVersion: true,
        pool: 'framework',
      });
    seed('@framework/core', [
      {
        tag: '18.0.0',
        host: false,
        action: 'skip',
        remotes: [tagged('team/mfe-a', '@framework/core', '^18.0.0')],
      },
      {
        tag: '17.0.0',
        host: false,
        action: 'skip',
        remotes: [tagged('team/mfe-b', '@framework/core', '^17.0.0')],
      },
    ]);
    seed('@design-system/ui', [
      {
        tag: '1.0.0',
        host: false,
        action: 'skip',
        remotes: [tagged('team/mfe-a', '@design-system/ui', '^1.0.0')],
      },
      {
        tag: '1.0.0',
        host: false,
        action: 'skip',
        remotes: [tagged('team/mfe-b', '@design-system/ui', '^1.0.0')],
      },
    ]);

    const importMap = await runInit();

    // Shared family (core + ds) is single-source on mfe-a.
    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@design-system/ui']).toContain(SCOPE['team/mfe-a']);

    // mfe-b scopes its WHOLE family — ds is NOT deduped despite matching version 1.0.0, so no foreign
    // framework runtime leaks in through the shared design system.
    const bScope = importMap.scopes?.[SCOPE['team/mfe-b']];
    expect(bScope?.['@framework/core']).toContain(SCOPE['team/mfe-b']);
    expect(bScope?.['@design-system/ui']).toContain(SCOPE['team/mfe-b']);
  });

  it('shares a single-provider member while an incompatible remote scopes its whole family', async () => {
    // mfe-b is compatible (core@17 matches) and sole provider of cdk. mfe-c is incompatible (core@18)
    // and islanded across its whole family.
    seed('@framework/core', [
      version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.0.0', '@framework/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      version('18.0.0', '@framework/core', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);
    seed('@framework/common', [
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-c', req: '^17.0.0' }]),
    ]);
    seed('@framework/cdk', [
      version('17.0.0', '@framework/cdk', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);

    const importMap = await runInit();

    // core: shared on mfe-a; mfe-b dedups (no scoped copy); mfe-c scopes (incompatible).
    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@framework/core']).toBeUndefined();
    expect(importMap.scopes?.[SCOPE['team/mfe-c']]?.['@framework/core']).toContain(
      SCOPE['team/mfe-c']
    );

    // common: shared on mfe-a; mfe-c scopes it too (whole-family, no dedup) even at the same version.
    expect(importMap.imports['@framework/common']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.scopes?.[SCOPE['team/mfe-c']]?.['@framework/common']).toContain(
      SCOPE['team/mfe-c']
    );

    // cdk: single-provider but compatible → shared from mfe-b (no orphan penalty).
    expect(importMap.imports['@framework/cdk']).toContain(SCOPE['team/mfe-b']);
    expect(importMap.scopes?.[SCOPE['team/mfe-b']]?.['@framework/cdk']).toBeUndefined();
  });

  it('does no work at all on a second init with unchanged entries (W2)', async () => {
    // Nothing is dirty the second time, so determine re-elects nothing and pooling has no signal to
    // act on. Its verdicts are already in storage — it wrote them itself — so recomputing them can
    // only reproduce them.
    seed('@framework/core', [
      version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('18.0.0', '@framework/core', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);
    seed('@framework/common', [
      version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      version('18.0.0', '@framework/common', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);

    const first = await runInit();
    // The first pass really did island a remote — mfe-c@18 wins the equal-cost tie on the newest tag,
    // so it is mfe-a that gives way — leaving a non-trivial result to preserve.
    expect(first.scopes?.[SCOPE['team/mfe-a']]?.['@framework/core']).toContain(SCOPE['team/mfe-a']);

    const writes = vi.spyOn(adapters.sharedExternalsRepo, 'addOrUpdate');
    const second = await runInit();

    expect(writes).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  it('scopes a dynamically-added incompatible remote whole family (dynamic init path)', async () => {
    // Existing coherent anchor (mfe-a @17) already committed.
    const shareVersion = (external: string): SharedExternal => ({
      dirty: false,
      versions: [
        {
          tag: '17.0.0',
          host: false,
          action: 'share',
          remotes: [meta('team/mfe-a', external, '^17.0.0')],
        },
      ],
    });
    adapters.sharedExternalsRepo.addOrUpdate(
      '@framework/core',
      shareVersion('@framework/core'),
      undefined
    );
    adapters.sharedExternalsRepo.addOrUpdate(
      '@framework/common',
      shareVersion('@framework/common'),
      undefined
    );

    const entryC: RemoteEntry = {
      name: 'team/mfe-c',
      url: 'http://mfe-c/remoteEntry.json',
      exposes: [],
      shared: [
        mockSharedInfo('@framework/core', {
          requiredVersion: '^18.0.0',
          version: '18.0.0',
          singleton: true,
          strictVersion: true,
        }),
        mockSharedInfo('@framework/common', {
          requiredVersion: '^18.0.0',
          version: '18.0.0',
          singleton: true,
          strictVersion: true,
        }),
      ],
    } as RemoteEntry;

    const updated = await createUpdateCache(config, adapters)(entryC);
    const pooled = await createPoolDynamicExternals(config, adapters)(updated);
    const importMap = await createConvertToImportMap(config, adapters)(pooled);

    // The new remote serves its whole family from its own scope; nothing added to the global family.
    const cScope = importMap.scopes?.[SCOPE['team/mfe-c']];
    expect(cScope?.['@framework/core']).toContain(SCOPE['team/mfe-c']);
    expect(cScope?.['@framework/common']).toContain(SCOPE['team/mfe-c']);
    expect(importMap.imports['@framework/core']).toBeUndefined();
    expect(importMap.imports['@framework/common']).toBeUndefined();
  });

  it('dedups a dynamically-added remote onto a committed island (dynamic init path)', async () => {
    // The case a committed `scope` copy exists for, and the only reason the global path had to learn to
    // carry a per-consumer override: mfe-b is an island on the previous major, so its files sit in the map
    // under its own scope and nothing global names them. A remote loaded later that ships exactly that
    // family cannot use the 18 winner — but it can use mfe-b's build, and taking it costs no download at
    // all. Without the override it would have downloaded its own copy of both members.
    //
    // The two winners come from two remotes on purpose: mfe-a wins core@18.0.0 and mfe-d wins
    // common@18.1.0, so no build shipped the pair the map would hand mfe-c and the witness cannot clear
    // it. `strictVersion: false` is what makes it a `skip` rather than a gate-1 island — it would accept
    // whatever is shared, and the promise is the only thing stopping it from mixing the two.
    const withIsland = (external: string, winner: string, tag: string): SharedExternal => ({
      dirty: false,
      versions: [
        {
          tag,
          host: false,
          action: 'share',
          remotes: [meta(winner, external, '^18.0.0')],
        },
        {
          tag: '17.0.0',
          host: false,
          action: 'scope',
          remotes: [meta('team/mfe-b', external, '^17.0.0')],
        },
      ],
    });
    adapters.sharedExternalsRepo.addOrUpdate(
      '@framework/core',
      withIsland('@framework/core', 'team/mfe-a', '18.0.0'),
      undefined
    );
    adapters.sharedExternalsRepo.addOrUpdate(
      '@framework/common',
      withIsland('@framework/common', 'team/mfe-d', '18.1.0'),
      undefined
    );

    const entryC: RemoteEntry = {
      name: 'team/mfe-c',
      url: 'http://mfe-c/remoteEntry.json',
      exposes: [],
      shared: [
        mockSharedInfo('@framework/core', {
          requiredVersion: '^17.0.0',
          version: '17.0.0',
          singleton: true,
          strictVersion: false,
        }),
        mockSharedInfo('@framework/common', {
          requiredVersion: '^17.0.0',
          version: '17.0.0',
          singleton: true,
          strictVersion: false,
        }),
      ],
    } as RemoteEntry;

    const updated = await createUpdateCache(config, adapters)(entryC);
    const pooled = await createPoolDynamicExternals(config, adapters)(updated);
    const importMap = await createConvertToImportMap(config, adapters)(pooled);

    // Every entrypoint it imports resolves to the island's files, not its own and not the 18 winner's.
    expect(importMap.scopes?.[SCOPE['team/mfe-c']]).toEqual({
      '@framework/core': `${SCOPE['team/mfe-b']}@framework/core.js`,
      '@framework/common': `${SCOPE['team/mfe-b']}@framework/common.js`,
    });
    expect(importMap.imports['@framework/core']).toBeUndefined();
  });

  it('reads the global mapping exactly as the import map emits it', async () => {
    // The gate decides on what a consumer would land on through `imports`, and `forEachGlobalClaim` is
    // that model. If the two ever drift the gate mis-decides silently, so this pins them against each
    // other on the shape that makes them differ: `@framework/core`'s winner is mfe-b, which does not carry
    // the `/testing` entrypoint, so the map publishes that one from a sibling copy of the same tag.
    seed('@framework/core', [
      {
        tag: '17.1.0',
        host: false,
        action: 'skip',
        remotes: [
          mockVersionRemote('team/mfe-b', '@framework/core', { requiredVersion: '^17.0.0' }),
          {
            ...mockVersionRemote('team/mfe-c', '@framework/core', { requiredVersion: '^17.0.0' }),
            entries: {
              '@framework/core': '@framework/core.js',
              '@framework/core/testing': '@framework/core_testing.js',
            },
          },
        ],
      },
    ]);
    seed('@framework/common', [
      version('17.1.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);

    const importMap = await runInit();
    const stored = adapters.sharedExternalsRepo.getFromScope(undefined);
    const { global } = committedView(
      Object.entries(stored).map(([name, external]) => ({ name, external }))
    );

    // Same specifiers, and each attributed to the remote whose scope URL the map really used.
    expect([...global.keys()].sort()).toEqual(Object.keys(importMap.imports).sort());
    for (const [specifier, url] of Object.entries(importMap.imports)) {
      expect(url).toContain(SCOPE[global.get(specifier)!.remote as keyof typeof SCOPE]);
    }
    expect(global.get('@framework/core/testing')!.remote).toBe('team/mfe-c');
  });
});
