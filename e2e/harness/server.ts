import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toChunkImport, CHUNK_PREFIX } from '@softarc/native-federation/domain';
import type { RemoteEntry } from 'lib/core/1.domain';
import { bundlesOf, entrypointsOf } from './portfolio';

/**
 * The network. One HTTP server dispatches on the `Host` header, and Chromium is launched with
 * `--host-resolver-rules=MAP * 127.0.0.1:<port>` (see `federation.ts`), so a remote declared at
 * `http://mfe1/remoteEntry.json` really is a separate origin to the browser: separate module map,
 * real CORS preflight-free simple requests, real `Referer` for import-map scope matching.
 *
 * Everything the browser fetches is generated from the portfolio a test declares, so a remote's
 * externals exist at exactly the paths its `remoteEntry.json` names.
 */

const HERE = __dirname;
const SHIMS = resolve(HERE, '../../node_modules/es-module-shims/dist/es-module-shims.js');

export const PAGE_HOST = 'host.service';
export const MANIFEST_URL = `http://${PAGE_HOST}/manifest.json`;

type File = { type: string; body: string };

/** What kind of thing a request was for, so a spec can count real downloads. */
export type RequestKind = 'page' | 'entry' | 'manifest' | 'external' | 'module' | 'chunk' | 'miss';

export type Request = { url: string; kind: RequestKind };

type Site = Map<string, { file: File; kind: RequestKind }>;

export type Portfolio = {
  /** Entries listed in the manifest served at `MANIFEST_URL`. */
  manifest: Record<string, string>;
  sites: Map<string, Site>;
};

const js = (body: string): File => ({ type: 'text/javascript', body });

/**
 * An external's file. Every copy records itself in `__nfCopies` on evaluation, which is how a spec
 * asks "how many builds of @angular/core did this page actually instantiate?" — the question the
 * import map exists to answer and that map JSON alone cannot.
 *
 * When the external declares a `bundle`, the file imports that bundle's chunks the way a real built
 * external does — so a deduped external drags its provider's chunk graph along, resolved against the
 * provider's scope rather than the consumer's.
 */
const externalModule = (
  from: string,
  pkg: string,
  version: string,
  entrypoint: string,
  chunks: string[]
) =>
  js(
    chunks.map(chunk => `import ${JSON.stringify(toChunkImport(chunk))};`).join('\n') +
      `\nconst id = ${JSON.stringify(`${from}|${pkg}@${version}`)};\n` +
      `(globalThis.__nfCopies ??= []).push({ id, from: ${JSON.stringify(from)}, ` +
      `pkg: ${JSON.stringify(pkg)}, version: ${JSON.stringify(version)}, ` +
      `entrypoint: ${JSON.stringify(entrypoint)}, url: import.meta.url });\n` +
      `export const __id = id;\n`
  );

/**
 * A remote's exposed module. It *statically imports every entrypoint its own remoteEntry declares*,
 * so loading it asserts the contract that a remote can resolve everything it shares, and reports
 * which build each specifier landed on — global for a dedup, its own for an island.
 */
const exposedModule = (entry: RemoteEntry) => {
  const specifiers = entry.shared
    .filter(shared => !shared.packageName.startsWith(`${CHUNK_PREFIX}/`))
    .flatMap(shared => Object.keys(entrypointsOf(shared)));
  const alias = (i: number) => `_${i}`;
  return js(
    specifiers.map((s, i) => `import * as ${alias(i)} from ${JSON.stringify(s)};`).join('\n') +
      `\nexport const remote = ${JSON.stringify(entry.name)};\n` +
      `export const seen = {\n` +
      specifiers.map((s, i) => `  ${JSON.stringify(s)}: ${alias(i)}.__id,`).join('\n') +
      `\n};\n`
  );
};

const pathOf = (url: string) => new URL(url).pathname;
const hostOf = (url: string) => new URL(url).host;

/** Compile declared remote entries into the files a browser needs to run them. */
export const compile = (entries: RemoteEntry[]): Portfolio => {
  const sites = new Map<string, Site>();
  const site = (host: string) => {
    if (!sites.has(host)) sites.set(host, new Map());
    return sites.get(host)!;
  };

  for (const entry of entries) {
    const host = hostOf(entry.url);
    const files = site(host);
    // Known in both chunking shapes: dense declares a `chunks` property, flat declares the chunks as
    // pseudo-externals and the harness keeps the bundle map on the side (see `bundlesOf`).
    const bundles = bundlesOf(entry);

    // The served entry is the recorded document: no `url`, since the provider adds that on fetch.
    const { url: _url, ...document } = entry as RemoteEntry & Record<string, unknown>;
    files.set(pathOf(entry.url), {
      kind: 'entry',
      file: { type: 'application/json', body: JSON.stringify(document) },
    });

    for (const shared of entry.shared) {
      // A chunk declared as a pseudo-external is still a chunk file: served below, with `kind: 'chunk'`,
      // so `nf.downloads()` counts the same things whichever shape declared it.
      if (shared.packageName.startsWith(`${CHUNK_PREFIX}/`)) continue;
      for (const [pkg, file] of Object.entries(entrypointsOf(shared)))
        files.set(`/${file}`, {
          kind: 'external',
          file: externalModule(
            host,
            shared.packageName,
            shared.version ?? '0.0.0',
            pkg,
            shared.bundle ? (bundles[shared.bundle] ?? []) : []
          ),
        });
    }

    for (const exposed of entry.exposes ?? [])
      files.set(`/${exposed.outFileName}`, { kind: 'module', file: exposedModule(entry) });

    // A chunk carries `__id` like an external does, so `nf.resolve` can report which origin a chunk
    // specifier resolved to — the question the per-origin chunk mapping exists to answer.
    const chunkFiles = new Set([
      ...Object.values(bundles).flat(),
      ...entry.shared
        .filter(shared => shared.packageName.startsWith(`${CHUNK_PREFIX}/`))
        .flatMap(shared => Object.values(entrypointsOf(shared))),
    ]);
    for (const chunk of chunkFiles)
      files.set(`/${chunk}`, {
        kind: 'chunk',
        file: js(
          `export const __chunk = true;\nexport const __id = ${JSON.stringify(`${host}|${chunk}`)};\n`
        ),
      });
  }

  return {
    manifest: Object.fromEntries(entries.map(e => [e.name, e.url])),
    sites,
  };
};

export const EMPTY: Portfolio = { manifest: {}, sites: new Map() };

export type Harness = {
  port: number;
  /** Replace what the network serves. Called once per `nf.init` with the test's portfolio. */
  serve: (portfolio: Portfolio) => void;
  /** Add entries to what is fetchable without listing them in the manifest (the dynamic path). */
  add: (entries: RemoteEntry[]) => void;
  requests: Request[];
  close: () => Promise<void>;
};

export const startServer = async (boot: string): Promise<Harness> => {
  const shims = readFileSync(SHIMS, 'utf8');
  let portfolio = EMPTY;
  const requests: Request[] = [];

  const page = (shim: boolean) => ({
    type: 'text/html',
    body:
      `<!doctype html><html><head><meta charset="utf-8"><title>nfo e2e</title>` +
      (shim
        ? `<script>window.esmsInitOptions={shimMode:true,mapOverrides:true}</script>` +
          `<script src="/es-module-shims.js"></script>`
        : ``) +
      // A classic script, deliberately: a `type="module"` boot would itself be a module load, and a
      // native import map must be installed before the first one.
      `<script src="/nfo-e2e.js"></script></head><body></body></html>`,
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? PAGE_HOST}`);
    const host = url.host;
    const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

    const send = (file: File, kind: RequestKind) => {
      requests.push({ url: `http://${host}${url.pathname}`, kind });
      res.writeHead(200, { ...cors, 'content-type': file.type });
      res.end(file.body);
    };

    if (host === PAGE_HOST) {
      if (url.pathname === '/') return send(page(url.searchParams.get('shim') === '1'), 'page');
      if (url.pathname === '/es-module-shims.js') return send(js(shims), 'page');
      if (url.pathname === '/nfo-e2e.js') return send(js(boot), 'page');
      if (url.pathname === '/manifest.json')
        return send(
          { type: 'application/json', body: JSON.stringify(portfolio.manifest) },
          'manifest'
        );
    }

    const found = portfolio.sites.get(host)?.get(url.pathname);
    if (found) return send(found.file, found.kind);

    // `nf.resolve` probes one specifier from inside an origin: a module served by that origin whose
    // only job is to re-export whatever the import map resolves the specifier to.
    const probe = /^\/__probe\/(.+)\.js$/.exec(url.pathname);
    if (probe)
      return send(
        js(`export { __id } from ${JSON.stringify(decodeURIComponent(probe[1]!))};\n`),
        'module'
      );

    requests.push({ url: `http://${host}${url.pathname}`, kind: 'miss' });
    res.writeHead(404, cors);
    res.end(`no fixture for http://${host}${url.pathname}`);
  });

  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };

  return {
    port,
    serve: next => {
      portfolio = next;
    },
    add: entries => {
      const extra = compile(entries);
      for (const [host, files] of extra.sites) {
        const target = portfolio.sites.get(host) ?? new Map();
        for (const [path, file] of files) target.set(path, file);
        portfolio.sites.set(host, target);
      }
    },
    requests,
    close: () => new Promise<void>(done => server.close(() => done())),
  };
};
