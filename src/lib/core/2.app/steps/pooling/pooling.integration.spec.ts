import type { RemoteEntry, SharedExternal } from 'lib/core/1.domain';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
import { portfolio } from 'lib/testing/pooling/portfolio';
import { tagSharedInfoByNpmScope } from 'lib/testing/pooling/tag-by-npm-scope';

/**
 * End-to-end coherence through pool → determine → import map. Pooling does not make a family resolve
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
});
