import { INIT_FLOW_FACTORY } from './init.factory';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockRemoteEntry_MFE1 } from 'lib/testing/domain/remote-entry/remote-entry.mock';
import { mockScopeUrl_MFE1 } from 'lib/testing/domain/scope-url.mock';
import type { RemoteEntry } from 'lib/core/1.domain';

describe('INIT_FLOW_FACTORY', () => {
  // A host with its own remote entry provider passes it in here (as node does), so the transform must apply to it.
  it('applies devtools.transformRemoteEntryFn to the remote entry provider it is given', async () => {
    const adapters = mockAdapters();
    vi.mocked(adapters.remoteEntryProvider.provide).mockResolvedValue(mockRemoteEntry_MFE1());
    const config = mockConfig();
    config.devtools.transformRemoteEntryFn = (entry: RemoteEntry) => ({ ...entry, exposes: [] });

    const factory = INIT_FLOW_FACTORY({ config, adapters });

    await expect(
      factory.adapters.remoteEntryProvider.provide(mockScopeUrl_MFE1({ file: 'remoteEntry.json' }))
    ).resolves.toEqual({ ...mockRemoteEntry_MFE1(), exposes: [] });
  });
});
