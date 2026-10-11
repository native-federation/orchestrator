import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';

// The portfolio's oracles build the pool graph too, after the flow resolves, so only in-flow builds count.
const state = vi.hoisted(() => ({ inFlow: false, flowBuilds: vi.fn() }));
const { flowBuilds } = state;
vi.mock('lib/core/1.domain/pooling/membership', async importOriginal => {
  const actual = await importOriginal<typeof import('lib/core/1.domain/pooling/membership')>();
  return {
    ...actual,
    buildPools: (...args: Parameters<typeof actual.buildPools>) => {
      if (state.inFlow) state.flowBuilds();
      return actual.buildPools(...args);
    },
  };
});
vi.mock('lib/core/2.app/flows/init.flow', async importOriginal => {
  const actual = await importOriginal<typeof import('lib/core/2.app/flows/init.flow')>();
  return {
    ...actual,
    createInitFlow: (...args: Parameters<typeof actual.createInitFlow>) => {
      const flow = actual.createInitFlow(...args);
      return async (...input: Parameters<typeof flow>) => {
        state.inFlow = true;
        try {
          return await flow(...input);
        } finally {
          state.inFlow = false;
        }
      };
    },
  };
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
    flowBuilds.mockClear();
    await p.runInit([a, b]);
    expect(flowBuilds).toHaveBeenCalled();

    p.reload();
    flowBuilds.mockClear();
    await p.runInit([a, b]);
    expect(flowBuilds).not.toHaveBeenCalled();

    // Control: a redeploy dirties the pool, so the graph is built again.
    p.reload();
    await p.runInit([a, entry('team/b', 'http://b/v2/remoteEntry.json', '17.2.0')]);
    expect(flowBuilds).toHaveBeenCalled();
  });
});
