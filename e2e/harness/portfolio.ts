import { mockSharedInfo } from 'lib/testing/domain/remote-entry/shared-info.mock';
import { mockExposedModule } from 'lib/testing/domain/remote-entry/exposes-info.mock';
import type { DenseSharedInfo, RemoteEntry } from 'lib/core/1.domain';
import legacyOverview from '../fixtures/legacy-overview.remoteEntry.json';
import documentApproval from '../fixtures/document-approval.remoteEntry.json';
import settingsPanel from '../fixtures/settings-panel.remoteEntry.json';
import settingsPortal from '../fixtures/settings-portal.remoteEntry.json';
import dataMutations from '../fixtures/data-mutations.remoteEntry.json';
import tools from '../fixtures/tools.remoteEntry.json';
import supportWidget from '../fixtures/support-widget.remoteEntry.json';
import legacyWidget from '../fixtures/legacy-widget.remoteEntry.json';
import strictPin from '../fixtures/strict-pin.remoteEntry.json';
import designSystem from '../fixtures/design-system.remoteEntry.json';
import shell from '../fixtures/shell.remoteEntry.json';

/**
 * The declaration layer: everything a test says about the *input* — which remotes exist, and what
 * each one's `remoteEntry.json` declares. `server.ts` turns these into files a browser can fetch.
 */

/** Origins the specs use. Every one resolves to the local server (see `EXPOSED_MODULE` in server.ts). */
export const SCOPE = {
  host: 'http://host.service/',
  a: 'http://mfe-a/',
  b: 'http://mfe-b/',
  c: 'http://mfe-c/',
  d: 'http://mfe-d/',
  x: 'http://mfe-x/',
  y: 'http://mfe-y/',
  z: 'http://mfe-z/',
  legacy: 'http://legacy/',
  legacyA: 'http://legacy-a/',
  legacyB: 'http://legacy-b/',
  legacyC: 'http://legacy-c/',
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

/** A remote whose externals live in chunk bundles, so the map has chunk imports to serve. */
export const withChunks = (entry: RemoteEntry, chunks: Record<string, string[]>): RemoteEntry =>
  ({ ...entry, chunks }) as RemoteEntry;

const FIXTURES = {
  'legacy-overview': legacyOverview,
  'document-approval': documentApproval,
  'settings-panel': settingsPanel,
  'settings-portal': settingsPortal,
  'data-mutations': dataMutations,
  tools,
  'support-widget': supportWidget,
  'legacy-widget': legacyWidget,
  'strict-pin': strictPin,
  'design-system': designSystem,
  shell,
} as const;

export type FixtureName = keyof typeof FIXTURES;

/** The seven anonymized production entries; the other four are synthetic (see fixtures/README.md). */
export const CAPTURED_SEVEN: FixtureName[] = [
  'legacy-overview',
  'document-approval',
  'settings-panel',
  'settings-portal',
  'data-mutations',
  'tools',
  'support-widget',
];

/**
 * A recorded `remoteEntry.json` from `e2e/fixtures`, served from `http://<name>/`. Handed over raw:
 * the real remote-entry provider normalizes it on fetch, including the older sparse `outFileName`
 * shape two of the captured entries still use.
 */
export const fixture = (name: FixtureName): RemoteEntry =>
  ({ ...FIXTURES[name], url: `http://${name}/remoteEntry.json` }) as unknown as RemoteEntry;

/** Every entrypoint a shared external declares, across both the dense and the sparse shape. */
export const entrypointsOf = (shared: DenseSharedInfo): Record<string, string> => {
  const sparse = shared as DenseSharedInfo & { outFileName?: string };
  return (
    shared.entries ?? { [shared.packageName]: sparse.outFileName ?? `${shared.packageName}.js` }
  );
};
