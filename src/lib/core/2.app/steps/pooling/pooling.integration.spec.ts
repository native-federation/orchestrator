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
});
