import type { RemoteEntry, SharedExternal } from 'lib/core/1.domain';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { portfolio } from 'lib/testing/pooling/portfolio';
import { tagSharedInfoByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';
import { committedView } from 'lib/core/1.domain/pooling/views';

/**
 * End-to-end coherence through determine → pooling → import map. Pooling does not make a family resolve
 * from one build — different members may legitimately be served from different remotes. What it
 * guarantees is that no single remote ends up drawing on builds that disagree: an incompatible or
 * disagreeing remote serves its whole `@framework/*` family from its own build, with no dedup, so a
 * foreign runtime cannot leak in through a shared sibling.
 *
 * Every init and dynamic load runs through the portfolio harness, which asserts no-tear on the emitted
 * map. None of these portfolios has a host. Family coherence proper (the two #63 cases, patch-drift
 * tolerance, asymmetric coverage) is locked in `pooling.regression.spec.ts`.
 */
describe('pooling (integration)', () => {
  const SCOPE = {
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
    'team/mfe-c': 'http://mfe-c/',
    'team/mfe-d': 'http://mfe-d/',
  };

  let p: ReturnType<typeof portfolio>;
  beforeEach(() => {
    p = portfolio(SCOPE, { storage: 'nf-pool-integration' });
  });

  const meta = (remote: string, external: string, req: string) =>
    mockVersionRemote(remote, external, { requiredVersion: req, strictVersion: true });

  it('keeps an entire compatible @framework family on a single remote build', async () => {
    // Both remotes accept either tag, so both candidates cost one download and the tie breaks toward
    // the newest: mfe-b's 17.1.0 wins the whole family and mfe-a's older tag dedups onto it, so the
    // family stays single-source rather than splitting.
    p.seed('@framework/core', [
      p.version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      p.version('17.1.0', '@framework/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);
    p.seed('@framework/common', [
      p.version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      p.version('17.1.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);

    const importMap = await p.runInit();

    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-b']);
    expect(importMap.imports['@framework/common']).toContain(SCOPE['team/mfe-b']);
    expect(importMap.imports['@framework/common']).not.toContain(SCOPE['team/mfe-a']);
    // mfe-a dedups the whole family — no scoped copy of either member.
    expect(importMap.scopes?.[SCOPE['team/mfe-a']]).toBeUndefined();
  });

  it('scopes an incompatible remote whole family, keeping the global family single-source', async () => {
    p.seed('@framework/core', [
      p.version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      p.version('17.1.0', '@framework/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      p.version('18.0.0', '@framework/core', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);
    p.seed('@framework/common', [
      p.version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      p.version('17.1.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      p.version('18.0.0', '@framework/common', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);

    const importMap = await p.runInit();

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
    // incompatible, so nobody serves its own family — every member is shared, forms included.
    p.seed('@framework/core', [
      p.version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
    ]);
    p.seed('@framework/common', [
      p.version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      p.version('17.0.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);
    p.seed('@framework/forms', [
      p.version('17.0.0', '@framework/forms', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);

    const importMap = await p.runInit();

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
    // toward the newest and mfe-a@18 wins round 1. mfe-b runs framework 17, incompatible with
    // that build, so it scopes its ENTIRE family — ui included, with NO dedup — so no second
    // framework runtime leaks in through the shared design system.
    const tagged = (remote: string, external: string, req: string) =>
      mockVersionRemote(remote, external, {
        requiredVersion: req,
        strictVersion: true,
        pool: 'framework',
      });
    p.seed('@framework/core', [
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
    p.seed('@design-system/ui', [
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

    const importMap = await p.runInit();

    // Shared family (core + ds) is single-source on mfe-a.
    expect(importMap.imports['@framework/core']).toContain(SCOPE['team/mfe-a']);
    expect(importMap.imports['@design-system/ui']).toContain(SCOPE['team/mfe-a']);

    // mfe-b scopes its WHOLE family — ds is NOT deduped despite matching version 1.0.0, so no foreign
    // framework runtime leaks in through the shared design system.
    const bScope = importMap.scopes?.[SCOPE['team/mfe-b']];
    expect(bScope?.['@framework/core']).toContain(SCOPE['team/mfe-b']);
    expect(bScope?.['@design-system/ui']).toContain(SCOPE['team/mfe-b']);

    // The committed record says so too: both members carry the pool's name (the one tag every copy
    // declared), and each of mfe-b's copies records why it self-serves. mfe-a's copies carry no cause.
    const record = p.adapters.sharedExternalsRepo.getFromScope();
    const causes = (name: string) =>
      Object.fromEntries(
        record[name]!.versions.flatMap(v => v.remotes.map(r => [r.name, r.poolCause]))
      );
    expect(record['@framework/core']!.poolName).toBe('framework');
    expect(record['@design-system/ui']!.poolName).toBe('framework');
    expect(causes('@framework/core')).toEqual({
      'team/mfe-a': undefined,
      'team/mfe-b': 'incompatible',
    });
    expect(causes('@design-system/ui')).toEqual({
      'team/mfe-a': undefined,
      'team/mfe-b': 'incompatible',
    });
  });

  it('shares a single-provider member while an incompatible remote scopes its whole family', async () => {
    // mfe-b is compatible (core@17 matches) and sole provider of cdk. mfe-c is incompatible (core@18)
    // and islanded across its whole family.
    p.seed('@framework/core', [
      p.version('17.0.0', '@framework/core', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      p.version('17.0.0', '@framework/core', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
      p.version('18.0.0', '@framework/core', [{ remote: 'team/mfe-c', req: '^18.0.0' }]),
    ]);
    p.seed('@framework/common', [
      p.version('17.0.0', '@framework/common', [{ remote: 'team/mfe-a', req: '^17.0.0' }]),
      p.version('17.0.0', '@framework/common', [{ remote: 'team/mfe-c', req: '^17.0.0' }]),
    ]);
    p.seed('@framework/cdk', [
      p.version('17.0.0', '@framework/cdk', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);

    const importMap = await p.runInit();

    // core: shared at 17 — mfe-a's and mfe-b's builds tie, both agree with each other, and either serves
    // both through the global map; neither keeps a scoped copy. mfe-c scopes (incompatible).
    expect(importMap.imports['@framework/core']).toMatch(/^http:\/\/mfe-[ab]\//);
    expect(importMap.scopes?.[SCOPE['team/mfe-a']]?.['@framework/core']).toBeUndefined();
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

  it('scopes a dynamically-added incompatible remote whole family (dynamic init path)', async () => {
    // Existing coherent winner (mfe-a @17) already committed.
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
    p.adapters.sharedExternalsRepo.addOrUpdate(
      '@framework/core',
      shareVersion('@framework/core'),
      undefined
    );
    p.adapters.sharedExternalsRepo.addOrUpdate(
      '@framework/common',
      shareVersion('@framework/common'),
      undefined
    );

    const entryC: RemoteEntry = {
      name: 'team/mfe-c',
      url: 'http://mfe-c/remoteEntry.json',
      exposes: [],
      // Tagged by npm scope, as the build does by default.
      shared: tagSharedInfoByNpmScope([
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
      ]),
    } as RemoteEntry;

    const { importMap } = await p.runDynamic(entryC);

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
    // it. `strictVersion: false` is what makes update-cache mark it `skip` rather than `scope` — it would
    // accept whatever is shared, and only pooling's no-tear placement stops it from mixing the two.
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
    p.adapters.sharedExternalsRepo.addOrUpdate(
      '@framework/core',
      withIsland('@framework/core', 'team/mfe-a', '18.0.0'),
      undefined
    );
    p.adapters.sharedExternalsRepo.addOrUpdate(
      '@framework/common',
      withIsland('@framework/common', 'team/mfe-d', '18.1.0'),
      undefined
    );

    const entryC: RemoteEntry = {
      name: 'team/mfe-c',
      url: 'http://mfe-c/remoteEntry.json',
      exposes: [],
      // Tagged by npm scope, as the build does by default.
      shared: tagSharedInfoByNpmScope([
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
      ]),
    } as RemoteEntry;

    const { importMap } = await p.runDynamic(entryC);

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
    p.seed('@framework/core', [
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
    p.seed('@framework/common', [
      p.version('17.1.0', '@framework/common', [{ remote: 'team/mfe-b', req: '^17.0.0' }]),
    ]);

    const importMap = await p.runInit();
    const stored = p.adapters.sharedExternalsRepo.getFromScope(undefined);
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
