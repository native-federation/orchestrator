import { initFederation } from 'lib/core/init-federation';
import { sessionStorageEntry } from 'lib/core/4.config/storage';
import { useShimImportMap } from 'lib/core/4.config/import-map';
import type { FederationManifest } from 'lib/core/1.domain';
import type { NativeFederationResult } from 'lib/core/init-federation.contract';

/**
 * Runs in the page. Nothing here substitutes for a part of the library: the import map is applied by
 * the library's own `replaceInDOM`, modules are loaded by its own `loadModuleFn`, storage is real
 * `sessionStorage`. The only injected option is the logger, and only to make its output readable
 * from Node.
 */

export type BootOptions = {
  pooling?: boolean;
  /**
   * `feature.convertFlatSharedInfo`: regroup a flat `shared` array back into one external per package
   * (`densifyExternals`) instead of leaving one external per entrypoint. No effect on a dense entry.
   */
  flatSharedInfo?: boolean;
  namespace?: string;
  /** Serve this URL as the host remote entry (`hostRemoteEntry`). */
  host?: string;
  profile?: Record<string, unknown>;
  /** Route the import map through es-module-shims in shim mode instead of a native import map. */
  shim?: boolean;
  /** Pass the manifest as a URL for the library to fetch, instead of as an object. */
  manifestUrl?: string;
};

export type Session = {
  warns: string[];
  debugs: string[];
  errors: string[];
  /** `sessionStorage.setItem` calls, so a spec can assert a warm init writes nothing. */
  writes: string[];
};

const session: Session = { warns: [], debugs: [], errors: [], writes: [] };

const write = sessionStorage.setItem.bind(sessionStorage);
sessionStorage.setItem = (key: string, value: string) => {
  session.writes.push(key);
  write(key, value);
};

let app: NativeFederationResult | undefined;

const options = (o: BootOptions) => ({
  storage: sessionStorageEntry,
  storageNamespace: o.namespace ?? 'e2e',
  logger: {
    debug: (_step: number, msg: string) => session.debugs.push(msg),
    warn: (_step: number, msg: string) => session.warns.push(msg),
    error: (_step: number, msg: string) => session.errors.push(msg),
  },
  logLevel: 'debug' as const,
  feature: {
    useAutoExternalPooling: o.pooling ?? true,
    convertFlatSharedInfo: o.flatSharedInfo ?? false,
  },
  ...(o.shim ? useShimImportMap({ shimMode: true }) : {}),
  ...(o.profile ? { profile: o.profile } : {}),
  ...(o.host ? { hostRemoteEntry: o.host } : {}),
});

const api = {
  session: () => session,

  init: async (manifest: FederationManifest, o: BootOptions = {}) => {
    session.writes.length = 0;
    app = await initFederation(o.manifestUrl ?? manifest, options(o));
    return session;
  },

  initRemoteEntry: async (url: string) => {
    session.writes.length = 0;
    await app!.initRemoteEntry(url);
    return session;
  },

  /** Every import map the library has put in the DOM, in order — the artefact the browser reads. */
  maps: (shim = false) =>
    Array.from(
      document.head.querySelectorAll(`script[type="${shim ? 'importmap-shim' : 'importmap'}"]`)
    ).map(script => JSON.parse(script.textContent ?? '{}')),

  /**
   * Load a remote's exposed module through the library. The module statically imports every
   * entrypoint its remoteEntry declared, so this both proves resolvability and reports which build
   * each specifier resolved to.
   */
  load: async (remoteName: string, exposedModule: string) => {
    const module = await app!.loadRemoteModule<{ remote: string; seen: Record<string, string> }>(
      remoteName,
      exposedModule
    );
    return { remote: module.remote, seen: module.seen };
  },

  /**
   * Resolve one bare specifier from inside a given origin — the raw import-map question, for
   * specifiers no remote statically imports. Served by the harness as a module at `<scope>__probe/…`,
   * so the browser applies that scope's mappings exactly as it would for the remote's own code.
   */
  resolve: async (specifier: string, scopeUrl: string, shim = false) => {
    const url = `${scopeUrl}__probe/${encodeURIComponent(specifier)}.js`;
    const load = shim
      ? (globalThis as unknown as { importShim: (u: string) => Promise<{ __id: string }> })
          .importShim
      : (u: string) => import(/* @vite-ignore */ u);
    try {
      return (await load(url)).__id as string;
    } catch (e) {
      return `UNRESOLVED: ${e instanceof Error ? e.message : String(e)}`;
    }
  },

  /** Every external file the page evaluated, in order, with the build it came from. */
  copies: () => (globalThis as { __nfCopies?: Array<Record<string, unknown>> }).__nfCopies ?? [],

  storage: () => ({ ...sessionStorage }) as Record<string, string>,
};

(globalThis as unknown as { __nfe2e: typeof api }).__nfe2e = api;

export type BootApi = typeof api;
