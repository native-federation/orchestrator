/**
 * Node.js module customization hooks for native-federation.
 *
 * Registered via `module.register(<this file>, import.meta.url, { data: { port }, transferList: [port] })`
 * from the orchestrator. The main thread posts the resolved import map over the
 * MessagePort whenever it changes; this loader rewrites `import` specifiers
 * accordingly and fetches http(s) modules into the loader as source text.
 */

import type { MessagePort } from 'node:worker_threads';

type Imports = Record<string, string>;
type Scopes = Record<string, Imports>;
type ImportMap = { imports: Imports; scopes?: Scopes };

/** Per-specifier list of export names to re-export from the published share scope. */
type ShareScopeKeys = Record<string, string[]>;

type InitData = {
  port?: MessagePort;
  initialImportMap?: ImportMap;
};

type IncomingMessage =
  | { type: 'set-import-map'; map: ImportMap }
  | { type: 'set-share-scope'; keys?: ShareScopeKeys };

const EMPTY_MAP: ImportMap = Object.freeze({ imports: {}, scopes: {} });

/** Synthetic URL scheme for specifiers bridged to the host's share scope. */
const SHARE_PREFIX = 'nf-share:';
/** Global key on the main thread holding `{ [specifier]: namespaceObject }`. */
const SHARE_SCOPE_GLOBAL = '__NF_SHARE_SCOPE__';

const baseURL = (() => {
  const cwd = process.cwd();
  const url = new URL('file://');
  url.pathname = cwd.endsWith('/') ? cwd : cwd + '/';
  return url.href.endsWith('/') ? url.href : url.href + '/';
})();

let activeMap: ImportMap = EMPTY_MAP;
let shareScopeKeys: ShareScopeKeys = Object.create(null);

export function initialize(data: InitData = {}): void {
  if (data.initialImportMap) {
    activeMap = normalize(data.initialImportMap);
  }
  if (data.port) {
    data.port.on('message', (msg: IncomingMessage) => {
      if (msg && msg.type === 'set-import-map') {
        activeMap = normalize(msg.map);
        data.port!.postMessage({ type: 'import-map-applied' });
      } else if (msg && msg.type === 'set-share-scope') {
        shareScopeKeys = msg.keys ?? Object.create(null);
        data.port!.postMessage({ type: 'share-scope-applied' });
      }
    });
    data.port.unref?.();
  }
}

type ResolveContext = { parentURL?: string };
type ResolveResult = { url: string; format?: string | null; shortCircuit?: boolean };
type NextResolve = (specifier: string, context?: ResolveContext) => Promise<ResolveResult>;

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve
): Promise<ResolveResult> {
  // Bridged specifiers win over the import map: route them to a synthetic
  // module that re-exports from the host's published share scope.
  if (Object.prototype.hasOwnProperty.call(shareScopeKeys, specifier)) {
    return { url: SHARE_PREFIX + encodeURIComponent(specifier), shortCircuit: true };
  }
  const mapped = resolveSpecifier(activeMap, specifier, context.parentURL);
  return nextResolve(mapped ?? specifier, context);
}

type LoadContext = { format?: string | null };
type LoadResult = {
  format: string;
  source?: string | ArrayBuffer | Uint8Array;
  shortCircuit?: boolean;
};
type NextLoad = (url: string, context?: LoadContext) => Promise<LoadResult>;

export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad
): Promise<LoadResult> {
  if (url.startsWith(SHARE_PREFIX)) {
    const specifier = decodeURIComponent(url.slice(SHARE_PREFIX.length));
    return {
      shortCircuit: true,
      format: 'module',
      source: synthShareModule(specifier, shareScopeKeys[specifier]),
    };
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch module from ${url}: ${res.status} ${res.statusText}`);
    }
    const source = await res.text();
    return { shortCircuit: true, format: 'module', source };
  }
  if (!url.startsWith('node:')) {
    context.format = 'module';
  }
  return nextLoad(url, context);
}

// --- share-scope bridge ----------------------------------------------------
// Synthesizes an in-memory ESM module whose exports forward to the namespace
// the host published on `globalThis[SHARE_SCOPE_GLOBAL]`. The export-key list
// is computed on the main thread (where the namespace lives) and shipped over
// the port, so the loader realm never has to enumerate a namespace it can't
// see. The `globalThis[...]` reads below run at module-eval time on the main
// thread, where the instances actually exist.

function synthShareModule(specifier: string, keys: string[] | undefined): string {
  const ID = /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u;
  const ref = `globalThis[${JSON.stringify(SHARE_SCOPE_GLOBAL)}][${JSON.stringify(specifier)}]`;
  const lines = [
    `const __ns = ${ref};`,
    `if (!__ns) throw new Error(${JSON.stringify(
      `[native-federation] share scope '${specifier}' not published`
    )});`,
  ];
  let hasDefault = false;
  for (const k of keys ?? []) {
    if (k === 'default') {
      hasDefault = true;
      continue;
    }
    // Defensive: only emit syntactically valid export identifiers. Angular's
    // ɵ… names pass \p{ID_Start}; anything else is skipped.
    if (ID.test(k)) lines.push(`export const ${k} = __ns[${JSON.stringify(k)}];`);
  }
  if (hasDefault) lines.push(`export default __ns["default"];`);
  return lines.join('\n') + '\n';
}

// --- WICG import-map resolve algorithm ------------------------------------
// https://wicg.github.io/import-maps/#new-resolve-algorithm

function resolveSpecifier(map: ImportMap, specifier: string, parentURL?: string): string | null {
  const currentBaseURL = parentURL ? parentURL.slice(0, parentURL.lastIndexOf('/') + 1) : baseURL;
  const normalizedSpecifier = parseURLLikeSpecifier(specifier, currentBaseURL) ?? specifier;

  if (map.scopes) {
    for (const scopePrefix in map.scopes) {
      if (
        scopePrefix === currentBaseURL ||
        (scopePrefix.endsWith('/') && currentBaseURL.startsWith(scopePrefix))
      ) {
        const match = resolveImportsMatch(normalizedSpecifier, map.scopes[scopePrefix]!);
        if (match) return match;
      }
    }
  }

  return resolveImportsMatch(normalizedSpecifier, map.imports);
}

function resolveImportsMatch(normalizedSpecifier: string, specifierMap: Imports): string | null {
  for (const specifierKey in specifierMap) {
    const resolutionResult = specifierMap[specifierKey];
    if (resolutionResult === undefined) continue;

    if (specifierKey === normalizedSpecifier) return resolutionResult;

    if (specifierKey.endsWith('/') && normalizedSpecifier.startsWith(specifierKey)) {
      const afterPrefix = normalizedSpecifier.slice(specifierKey.length);
      try {
        return new URL(afterPrefix, resolutionResult).href;
      } catch {
        throw new TypeError(
          `import-map resolution of '${specifierKey}' failed due to URL parse failure`
        );
      }
    }
  }
  return null;
}

function parseURLLikeSpecifier(specifier: string, base: string): string | null {
  const useBase =
    specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../');
  try {
    return new URL(specifier, useBase ? base : undefined).href;
  } catch {
    return null;
  }
}

function normalize(parsed: ImportMap): ImportMap {
  return {
    imports: parsed.imports ?? {},
    scopes: parsed.scopes ?? {},
  };
}
