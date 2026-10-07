import type { DrivingContract } from '../../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockVersionRemote } from 'lib/testing/domain/externals/version.mock';
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
 * Found by the pooling property test: a warm re-election must keep a tied round-1 winner. The tie rule
 * prefers the previous winner, which used to be inferred from the basis of the stored `share` rows. Rows
 * the winner's peers took over by rule 5 have a lender as their basis, so a lender with more such rows than
 * the winner has own rows was read as the previous winner and the election flipped. The winner is now
 * stored as `poolWinner`.
 *
 * r0 ships m0 and m4; r1 ships m1..m4; all at 18.1.1. Neither build serves the other, both agree, so the
 * election ties and arrival order elects r0.
 */
describe('pooling: a re-election keeps a tied winner', () => {
  const SCOPE = { r0: 'http://r0/', r1: 'http://r1/' } as const;

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-reelection-tie'),
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

  const seed = (name: string, remotes: string[]) => {
    const version: SharedVersion = {
      tag: '18.1.1',
      host: false,
      action: 'skip',
      remotes: remotes.map(r =>
        mockVersionRemote(r, name, { requiredVersion: '^18.1.1', strictVersion: true })
      ),
    };
    adapters.sharedExternalsRepo.addOrUpdate(
      name,
      tagStoredByNpmScope({ [name]: { dirty: true, versions: [version] } })[name]!,
      undefined
    );
  };

  const runInit = async () => {
    const pooled = await createMarkPoolsForReelection(config, adapters)();
    const touched = await createDetermineSharedExternals(config, adapters)(pooled);
    await createPoolSharedExternals(config, adapters)(touched);
    return createGenerateImportMap(config, adapters)();
  };

  const stored = () => structuredClone(adapters.sharedExternalsRepo.getFromScope(undefined));

  it('elects the same winner when every member is marked dirty again', async () => {
    seed('@fam/m0', ['r0']);
    seed('@fam/m1', ['r1']);
    seed('@fam/m2', ['r1']);
    seed('@fam/m3', ['r1']);
    seed('@fam/m4', ['r0', 'r1']);

    const coldMap = await runInit();
    const coldRecord = stored();

    expect(coldMap.imports['@fam/m4']).toBe('http://r0/@fam/m4.js');

    for (const name of Object.keys(coldRecord)) {
      const external = adapters.sharedExternalsRepo.getFromScope(undefined)[name]!;
      adapters.sharedExternalsRepo.addOrUpdate(name, { ...external, dirty: true }, undefined);
    }
    const warmMap = await runInit();

    expect(stored()).toEqual(coldRecord);
    expect(warmMap).toEqual(coldMap);
  });

  it('keeps the winner when a newly tagged member joins the tied pool', async () => {
    seed('@fam/m0', ['r0']);
    seed('@fam/m1', ['r1']);
    seed('@fam/m2', ['r1']);
    seed('@fam/m3', ['r1']);
    seed('@fam/m4', ['r0', 'r1']);
    const coldMap = await runInit();
    const coldM4 = stored()['@fam/m4'];

    // r1 starts shipping '@fam/a'. Members are ordered by name, so it now arrives first: the tie still holds,
    // and only the stored winner keeps it from flipping to r1. The joiner has no `poolWinner` yet.
    seed('@fam/a', ['r1']);
    const warmMap = await runInit();

    expect(stored()['@fam/m4']).toEqual(coldM4);
    expect(warmMap.imports['@fam/m4']).toBe(coldMap.imports['@fam/m4']);
    expect(Object.values(stored()).map(e => e.poolWinner)).toEqual(Array(6).fill('r0'));
  });
});
