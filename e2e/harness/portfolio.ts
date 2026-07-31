import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockExposedModule } from 'lib/testing/domain/remote-entry/exposes-info.mock';
import { toChunkImport } from '@softarc/native-federation/domain';
import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';
import mfe1 from '../fixtures/mfe1.remoteEntry.json';
import mfe2 from '../fixtures/mfe2.remoteEntry.json';
import mfe3 from '../fixtures/mfe3.remoteEntry.json';
import mfe4 from '../fixtures/mfe4.remoteEntry.json';
import mfe5 from '../fixtures/mfe5.remoteEntry.json';
import mfe6 from '../fixtures/mfe6.remoteEntry.json';
import mfe7 from '../fixtures/mfe7.remoteEntry.json';
import mfe8 from '../fixtures/mfe8.remoteEntry.json';
import mfe9 from '../fixtures/mfe9.remoteEntry.json';
import mfe10 from '../fixtures/mfe10.remoteEntry.json';
import mfe11 from '../fixtures/mfe11.remoteEntry.json';
import pooled1 from '../fixtures/pooling/mfe1.remoteEntry.json';
import pooled2 from '../fixtures/pooling/mfe2.remoteEntry.json';
import pooled3 from '../fixtures/pooling/mfe3.remoteEntry.json';

/**
 * The declaration layer: everything a test says about the *input* — which remotes exist, and what
 * each one's `remoteEntry.json` declares. `server.ts` turns these into files a browser can fetch.
 */

/**
 * Origins the specs use. Every one resolves to the local server (see `startServer` in server.ts).
 *
 * Deliberately anonymous and numbered in the order a portfolio declares them: nothing about a remote —
 * which framework line it is on, whether it is the one that islands — may be read off its name. Each
 * spec says that in a comment above the portfolio instead.
 */
export const SCOPE = {
  host: 'http://host.service/',
  mfe1: 'http://mfe1/',
  mfe2: 'http://mfe2/',
  mfe3: 'http://mfe3/',
  mfe4: 'http://mfe4/',
  mfe5: 'http://mfe5/',
} as const;

/** The name `hostRemoteEntry` assigns, so host fixtures match what the flow renames them to. */
export const HOST_NAME = '__NF-HOST__';

/** The exposed module every synthetic remote carries; `loadRemoteModule(name, EXPOSED)` loads it. */
export const EXPOSED = './comp';

export type DepOptions = {
  /** Declared `requiredVersion`; defaults to caret-on-its-own-version. */
  req?: string;
  /** `strictVersion`, default true — false means "accept whatever is shared". */
  strict?: boolean;
  /** `singleton`, default true — false means the external is scoped per remote, never shared. */
  singleton?: boolean;
  /** Explicit `pool` tag; joins this external to a family without auto-pooling. */
  pool?: string;
  shareScope?: string;
  /** Extra entrypoints of the same package, e.g. `['/http']` for `@angular/common/http`. */
  entrypoints?: string[];
  /** Chunk bundle this external's code lives in; chunks are mapped into the remote's scope. */
  bundle?: string;
};

/**
 * One shared dependency of a remote. Singleton by default, which is what a framework package is and
 * what makes an external shareable rather than scoped.
 */
export const dep = (pkg: string, version: string, o: DepOptions = {}): DenseSharedInfo => {
  const entries = Object.fromEntries(
    [pkg, ...(o.entrypoints ?? []).map(e => `${pkg}${e}`)].map(name => [name, `${name}.js`])
  );
  return mockSharedInfo(pkg, {
    singleton: o.singleton ?? true,
    strictVersion: o.strict ?? true,
    requiredVersion: o.req ?? `^${version}`,
    version,
    pool: o.pool,
    shareScope: o.shareScope,
    bundle: o.bundle,
    entries,
  });
};

export const remote = (name: string, scopeUrl: string, shared: DenseSharedInfo[]): RemoteEntry =>
  ({
    name,
    url: `${scopeUrl}remoteEntry.json`,
    exposes: [mockExposedModule(EXPOSED, 'comp.js')],
    shared,
  }) as RemoteEntry;

/**
 * Bundle → chunk files, kept for `server.ts` under a symbol: `JSON.stringify` ignores symbol keys, so
 * the harness knows a remote's chunk graph in both chunking shapes without ever serving it twice.
 */
const BUNDLES = Symbol('bundles');

type Bundles = Record<string, string[]>;
type Harnessed = RemoteEntry & { [BUNDLES]?: Bundles; chunks?: Bundles };

/** A remote whose externals live in chunk bundles, so the map has chunk imports to serve. */
export const withChunks = (entry: RemoteEntry, chunks: Bundles): RemoteEntry =>
  ({ ...entry, chunks, [BUNDLES]: chunks }) as RemoteEntry;

/** Bundle → chunk files of a remote, whichever chunking shape declared them. */
export const bundlesOf = (entry: RemoteEntry): Bundles => {
  const harnessed = entry as Harnessed;
  return harnessed[BUNDLES] ?? harnessed.chunks ?? {};
};

/**
 * The four shapes a built `remoteEntry.json` reaches the orchestrator in.
 *
 * `externals`: **dense** puts every entrypoint of a package in one `shared` element's `entries` map;
 * **flat** is the older shape, one element per entrypoint with an `outFileName`. Whether a flat entry is
 * regrouped into one external or stays one external per entrypoint is the `convertFlatSharedInfo`
 * decision — see `flatSharedInfo` in boot.ts.
 *
 * `chunking`: **dense** declares chunks in a `chunks` property, keyed by bundle; **flat** declares each
 * chunk as an `@nf-internal/chunk-*` pseudo-external in `shared`, non-singleton at version `0.0.0`.
 */
export type Shape = { externals: 'dense' | 'flat'; chunking: 'dense' | 'flat' };

export const SHAPES: Shape[] = [
  { externals: 'dense', chunking: 'dense' },
  { externals: 'dense', chunking: 'flat' },
  { externals: 'flat', chunking: 'dense' },
  { externals: 'flat', chunking: 'flat' },
];

export const shapeName = (shape: Shape) =>
  `${shape.externals} externals / ${shape.chunking} chunking`;

/**
 * One `shared` element per entrypoint, the pre-`entries` shape two of the captured fixtures still use.
 * `RemoteEntry` says `DenseSharedInfo[]` because that is what the provider hands the flow; a *served*
 * document is raw, so the cast is the point rather than a workaround.
 */
const flatExternals = (entry: RemoteEntry): RemoteEntry =>
  ({
    ...entry,
    shared: entry.shared.flatMap(shared =>
      Object.entries(entrypointsOf(shared)).map(([packageName, outFileName]) => {
        const { entries: _dense, ...rest } = shared as DenseSharedInfo;
        return { ...rest, packageName, outFileName };
      })
    ),
  }) as unknown as RemoteEntry;

/**
 * Chunks as pseudo-externals instead of a `chunks` property. They are non-singleton, so the resolver
 * never shares one: each declaring remote gets the specifier mapped into its own import-map scope.
 */
const flatChunking = (entry: RemoteEntry): RemoteEntry => {
  const bundles = bundlesOf(entry);
  const { chunks: _dense, ...rest } = entry as Harnessed;
  const chunkExternals = [...new Set(Object.values(bundles).flat())].map(file => ({
    packageName: toChunkImport(file),
    outFileName: file,
    singleton: false,
    strictVersion: false,
    version: '0.0.0',
    requiredVersion: '0.0.0',
  }));
  return {
    ...rest,
    shared: [...entry.shared, ...chunkExternals],
    [BUNDLES]: bundles,
  } as unknown as RemoteEntry;
};

/** Render a declared remote into one of the four shapes; `dense`/`dense` is what the builders emit. */
export const shape = (entry: RemoteEntry, { externals, chunking }: Shape): RemoteEntry => {
  const chunked = chunking === 'flat' ? flatChunking(entry) : entry;
  return externals === 'flat' ? flatExternals(chunked) : chunked;
};

const FIXTURES = {
  mfe1,
  mfe2,
  mfe3,
  mfe4,
  mfe5,
  mfe6,
  mfe7,
  mfe8,
  mfe9,
  mfe10,
  mfe11,
} as const;

export type FixtureName = keyof typeof FIXTURES;

/** `mfe1`–`mfe7` are the anonymized production entries; `mfe8`–`mfe11` are synthetic. See fixtures/README.md. */
export const CAPTURED_SEVEN: FixtureName[] = [
  'mfe1',
  'mfe2',
  'mfe3',
  'mfe4',
  'mfe5',
  'mfe6',
  'mfe7',
];

/**
 * A recorded `remoteEntry.json` from `e2e/fixtures`, served from `http://<name>/`. Handed over raw:
 * the real remote-entry provider normalizes it on fetch, including the older sparse `outFileName`
 * shape two of the captured entries still use.
 */
export const fixture = (name: FixtureName): RemoteEntry =>
  ({ ...FIXTURES[name], url: `http://${name}/remoteEntry.json` }) as unknown as RemoteEntry;

const POOLED = [pooled1, pooled2, pooled3] as const;

/**
 * A recorded-style entry from `e2e/fixtures/pooling`: flat externals, flat chunking, `pool` tags — the
 * combination none of the eleven captured entries has. See that folder's README.
 */
export const poolFixture = (n: 1 | 2 | 3): RemoteEntry =>
  ({ ...POOLED[n - 1], url: `http://mfe${n}/remoteEntry.json` }) as unknown as RemoteEntry;

/** Every entrypoint a shared external declares, across both the dense and the sparse shape. */
export const entrypointsOf = (shared: DenseSharedInfo): Record<string, string> => {
  const sparse = shared as DenseSharedInfo & { outFileName?: string };
  return (
    shared.entries ?? { [shared.packageName]: sparse.outFileName ?? `${shared.packageName}.js` }
  );
};
