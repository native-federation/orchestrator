import type { DrivingContract } from '../driving-ports/driving.contract';
import type { ConfigContract } from 'lib/core/2.app/config';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { Optional } from 'lib/utils/optional';
import type { RemoteEntry, RemoteInfo } from 'lib/core/1.domain';
import { createSharedExternalsRepository } from 'lib/core/3.adapters/storage/shared-externals.repository';
import { createVersionCheck } from 'lib/core/3.adapters/checks/version.check';
import { globalThisStorageEntry } from 'lib/core/4.config/storage/global-this.storage';
import { createProcessRemoteEntries } from './process-remote-entries';

/**
 * A warm init commits every remote it processes back onto the stored record. The pool's name and winner are
 * what the coming re-election reads (`poolWinner` breaks a tie), so a commit must carry them over.
 */
describe('store-remote-entry: pool results on commit', () => {
  const SCOPE = { 'team/mfe-a': 'http://mfe-a/', 'team/mfe-b': 'http://mfe-b/' } as const;

  let config: ConfigContract;
  let adapters: DrivingContract;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();
    adapters.versionCheck = createVersionCheck();
    adapters.sharedExternalsRepo = createSharedExternalsRepository({
      storage: globalThisStorageEntry('nf-commit-pool-state'),
      clearStorage: true,
    });
    adapters.remoteInfoRepo.tryGet = vi.fn((name: string) =>
      name in SCOPE
        ? Optional.of({ scopeUrl: SCOPE[name as keyof typeof SCOPE], exposes: [] } as RemoteInfo)
        : Optional.empty<RemoteInfo>()
    );
  });

  const entry = (name: keyof typeof SCOPE): RemoteEntry =>
    ({
      name,
      url: `${SCOPE[name]}remoteEntry.json`,
      exposes: [],
      shared: [
        mockSharedInfo('@fam/core', {
          requiredVersion: '^18.0.0',
          version: '18.1.1',
          singleton: true,
          strictVersion: true,
        }),
      ],
    }) as RemoteEntry;

  it('keeps poolName and poolWinner when another remote is committed onto the record', async () => {
    await createProcessRemoteEntries(config, adapters)([entry('team/mfe-a')]);
    const stored = adapters.sharedExternalsRepo.getFromScope(undefined)['@fam/core']!;
    adapters.sharedExternalsRepo.addOrUpdate(
      '@fam/core',
      { ...stored, poolName: 'fam', poolWinner: 'team/mfe-a' },
      undefined
    );

    await createProcessRemoteEntries(config, adapters)([entry('team/mfe-b')]);

    const record = adapters.sharedExternalsRepo.getFromScope(undefined)['@fam/core']!;
    expect(record.versions[0]!.remotes.map(r => r.name)).toEqual(['team/mfe-a', 'team/mfe-b']);
    expect(record.poolName).toBe('fam');
    expect(record.poolWinner).toBe('team/mfe-a');
  });

  // The commit spreads the cached record, so a field added to SharedExternal later is carried over without
  // touching the commit; listing fields one by one would drop it silently.
  it('keeps a field it does not know about when another remote is committed onto the record', async () => {
    await createProcessRemoteEntries(config, adapters)([entry('team/mfe-a')]);
    const stored = adapters.sharedExternalsRepo.getFromScope(undefined)['@fam/core']!;
    adapters.sharedExternalsRepo.addOrUpdate(
      '@fam/core',
      { ...stored, futureField: 'kept' } as typeof stored,
      undefined
    );

    await createProcessRemoteEntries(config, adapters)([entry('team/mfe-b')]);

    const record = adapters.sharedExternalsRepo.getFromScope(undefined)['@fam/core']!;
    expect(record.versions[0]!.remotes.map(r => r.name)).toEqual(['team/mfe-a', 'team/mfe-b']);
    expect(record).toMatchObject({ futureField: 'kept' });
  });
});
