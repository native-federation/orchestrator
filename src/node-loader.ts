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

type InitData = {
  port?: MessagePort;
  initialImportMap?: ImportMap;
};

const EMPTY_MAP: ImportMap = Object.freeze({ imports: {}, scopes: {} });

const baseURL = (() => {
  const cwd = process.cwd();
  const url = new URL('file://');
  url.pathname = cwd.endsWith('/') ? cwd : cwd + '/';
  return url.href.endsWith('/') ? url.href : url.href + '/';
})();

let activeMap: ImportMap = EMPTY_MAP;

export function initialize(data: InitData = {}): void {
  if (data.initialImportMap) {
    activeMap = normalize(data.initialImportMap);
  }
  if (data.port) {
    data.port.on('message', (msg: { type: 'set-import-map'; map: ImportMap }) => {
      if (msg && msg.type === 'set-import-map') {
        activeMap = normalize(msg.map);
        data.port!.postMessage({ type: 'import-map-applied' });
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
