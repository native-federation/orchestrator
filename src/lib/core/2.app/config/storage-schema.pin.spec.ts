import type {
  DenseSharedInfo,
  RemoteEntry,
  RemoteInfo,
  SharedExternal,
  SharedExternals,
} from 'lib/core/1.domain';
import { portfolio } from 'lib/testing/pooling/portfolio';

/**
 * A cache stamped by another orchestrator version is dropped (`STORAGE_VERSION_KEY`), so a
 * released shape change needs no bump of its own. Within one version it does matter: unbundled builds all
 * stamp 'dev' and keep each other's caches, and the release notes must say when an upgrade changes what is
 * stored. This pins the stored keys so such a change is a visible decision: a change that adds, renames or
 * drops one fails here, and the fix is to update the list and say so in the release notes.
 *
 * The keys are read off what a real page commits, so the portfolio below must exercise every optional
 * field: a host with exposes, integrity and chunks, a scoped external with a bundle, a subpool
 * (`servedBy`), an island (`poolCause`) and a stored election (`poolName`, `poolWinner`).
 */
describe('stored shape', () => {
  const NAMESPACE = 'nf-storage-schema-pin';

  const shared = (
    packageName: string,
    version: string,
    requiredVersion: string,
    o: Partial<DenseSharedInfo> = {}
  ): DenseSharedInfo =>
    ({
      packageName,
      version,
      requiredVersion,
      singleton: true,
      strictVersion: true,
      pool: 'fw',
      entries: { [packageName]: `${packageName.slice(1).replace('/', '_')}.js` },
      ...o,
    }) as DenseSharedInfo;

  const entry = (
    name: string,
    extra: Partial<RemoteEntry>,
    ...sharedInfo: DenseSharedInfo[]
  ): RemoteEntry =>
    ({
      name,
      url: `http://${name}/remoteEntry.json`,
      exposes: [],
      shared: sharedInfo,
      ...extra,
    }) as RemoteEntry;

  const keysOf = (objects: object[]) => [...new Set(objects.flatMap(o => Object.keys(o)))].sort();

  it('lists every stored key', async () => {
    const p = portfolio({}, { hosts: ['host'], storage: NAMESPACE, realRepositories: true });
    await p.runInit([
      entry(
        'host',
        {
          exposes: [{ key: './App', outFileName: 'app.js' }],
          integrity: { 'fw_core.js': 'sha384-pinned' },
          chunks: { 'browser-shared': ['chunk-1.js'] },
        },
        shared('@fw/core', '19.2.0', '^19.2.0', { bundle: 'browser-shared' }),
        shared('@fw/common', '19.2.0', '^19.2.0'),
        shared('tslib', '2.0.0', '^2.0.0', { singleton: false, pool: undefined, bundle: 'b' })
      ),
      // mfe-b and mfe-c pin 19.1.0, so they run mfe-b's build as a subpool; mfe-d's ~18 is an island.
      entry(
        'mfe-b',
        {},
        shared('@fw/core', '19.1.0', '19.1.0'),
        shared('@fw/anim', '19.1.0', '19.1.0')
      ),
      entry(
        'mfe-c',
        {},
        shared('@fw/core', '19.1.0', '19.1.0'),
        shared('@fw/anim', '19.1.0', '19.1.0')
      ),
      entry('mfe-d', {}, shared('@fw/core', '18.0.0', '~18.0.0')),
    ]);
    p.reload();

    const storage = (globalThis as unknown as Record<string, Record<string, unknown>>)[NAMESPACE]!;
    const externals = Object.values(storage['shared-externals'] as SharedExternals).flatMap(scope =>
      Object.values(scope)
    ) as SharedExternal[];
    const versions = externals.flatMap(e => e.versions);
    const remotes = Object.values(storage['remotes'] as Record<string, RemoteInfo>);
    const scoped = Object.values(
      storage['scoped-externals'] as Record<string, Record<string, object>>
    ).flatMap(byExternal => Object.values(byExternal));

    expect({
      storage: Object.keys(storage).sort(),
      sharedExternal: keysOf(externals),
      sharedVersion: keysOf(versions),
      sharedVersionMeta: keysOf(versions.flatMap(v => v.remotes)),
      remoteInfo: keysOf(remotes),
      remoteModule: keysOf(remotes.flatMap(r => r.exposes)),
      scopedVersion: keysOf(scoped),
    }).toEqual({
      storage: ['remotes', 'scoped-externals', 'shared-chunks', 'shared-externals'],
      sharedExternal: ['dirty', 'poolName', 'poolWinner', 'versions'],
      sharedVersion: ['action', 'host', 'remotes', 'tag'],
      sharedVersionMeta: [
        'bundle',
        'cached',
        'entries',
        'name',
        'pool',
        'poolCause',
        'requiredVersion',
        'servedBy',
        'strictVersion',
      ],
      remoteInfo: ['exposes', 'integrity', 'scopeUrl'],
      remoteModule: ['file', 'moduleName'],
      scopedVersion: ['bundle', 'entries', 'tag'],
    });
  });
});
