import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';
import { buildPools } from 'lib/core/1.domain/pooling/membership';
import { portfolio } from 'lib/testing/pooling/portfolio';

// Wraps the real `buildPools` so a test can count pool-graph builds through the whole init flow.
vi.mock('lib/core/1.domain/pooling/membership', async importOriginal => {
  const actual = await importOriginal<typeof import('lib/core/1.domain/pooling/membership')>();
  return { ...actual, buildPools: vi.fn(actual.buildPools) };
});

const shared = (packageName: string, version: string): DenseSharedInfo =>
  ({
    packageName,
    version,
    requiredVersion: `^${version}`,
    singleton: true,
    strictVersion: true,
    pool: 'fw',
    entries: { [packageName]: `${packageName.slice(1).replace('/', '_')}.js` },
  }) as DenseSharedInfo;

const entry = (name: string, url: string, version: string): RemoteEntry =>
  ({
    name,
    url,
    exposes: [],
    shared: [shared('@fw/core', version), shared('@fw/common', version)],
  }) as unknown as RemoteEntry;

/**
 * Warm re-election must stay cheap: a scope with nothing dirty is skipped before any pool graph is built,
 * which measured as the whole pooling cost of a warm init. Spreading dirty by stored pool name happens only
 * past that gate.
 */
describe('pooling cost', () => {
  it('a clean warm init builds no pool graph; a redeploy does', async () => {
    const p = portfolio({}, { storage: 'nf-pooling-cost', realRepositories: true });
    const a = entry('team/a', 'http://a/remoteEntry.json', '17.0.0');
    const b = entry('team/b', 'http://b/remoteEntry.json', '17.1.0');

    // Control: the mock sees the flow's calls at all.
    vi.mocked(buildPools).mockClear();
    await p.runInit([a, b]);
    expect(buildPools).toHaveBeenCalled();

    p.reload();
    vi.mocked(buildPools).mockClear();
    await p.runInit([a, b]);
    expect(buildPools).not.toHaveBeenCalled();

    // Control: a redeploy dirties the pool, so the graph is built again.
    p.reload();
    await p.runInit([a, entry('team/b', 'http://b/v2/remoteEntry.json', '17.2.0')]);
    expect(buildPools).toHaveBeenCalled();
  });
});
