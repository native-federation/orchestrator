# End-to-end suite

```
npm run test-e2e            # the whole suite
npx playwright test -c e2e/playwright.config.ts ranges     # one file
npx playwright test -c e2e/playwright.config.ts --ui       # interactive
```

Not part of `npm test`, which runs the unit suite under vitest.

## What "end to end" means here

Every spec runs the **real orchestrator in a real Chromium**, over a real network, and asserts on what
the browser ended up doing. Nothing is stubbed: `initFederation` is the published entry point, the import
map is installed by the library's own `replaceInDOM`, modules are loaded by its own `loadModuleFn`, and
storage is the browser's `sessionStorage`. The only injected option is the logger, so its output can be
read from Node.

Concretely, that buys four kinds of assertion the previous jsdom suite could not make:

| assertion                | how                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| the map the browser reads | parsed out of the `<script type="importmap">` elements in the document, in commit order — not captured from a `setImportMapFn` spy |
| which build a remote runs | every remote's exposed module statically imports **every entrypoint its remoteEntry declares** and reports what each one resolved to (`nf.load`, `nf.loadAll`) |
| the real download cost    | files the HTTP server actually served (`nf.downloads`, `nf.fetches`, `nf.chunkLoads`), and copies the page actually evaluated (`nf.copies`, `nf.buildsOf`) |
| a warm start             | `nf.init` is a page load; calling it twice against the same `sessionStorage` is the refresh a user gets                            |

A test that merely loads is already meaningful: if the map failed to cover an entrypoint some remote
declared, the static import throws and the test fails.

## The harness

`harness/` is the whole apparatus, in four pieces:

- **`portfolio.ts`** — the declaration layer. `dep()` / `remote()` / `withChunks()` build `remoteEntry`
  documents; `fixture()` loads a recorded one from [`fixtures/`](fixtures/README.md). `SCOPE` holds the
  origins the specs use.
- **`server.ts`** — one HTTP server that dispatches on the `Host` header, and compiles a portfolio into
  the files a browser needs: each `remoteEntry.json`, one ES module per declared entrypoint, one per
  exposed module, one per chunk. Chromium is launched with `--host-resolver-rules=MAP * 127.0.0.1:<port>`,
  so `http://mfe-a/` really is a separate origin to the browser — real CORS, real `Referer`, real
  import-map scope matching. The generated externals record themselves in `globalThis.__nfCopies` on
  evaluation, which is how copy counts are measured rather than inferred.
- **`boot.ts`** — runs in the page, bundled by esbuild straight from `src/lib`. Exposes `initFederation`
  and a few readers (`maps`, `load`, `resolve`, `copies`, `storage`) on `window.__nfe2e`. Loaded as a
  **classic** script on purpose: a `type="module"` boot would itself be a module load, and a native
  import map has to be installed before the first one.
- **`federation.ts`** — the Playwright fixture. Server and browser are worker-scoped, `nf` is per test.

Native import maps are the default. `{ shim: true }` switches a test to the
`useShimImportMap({ shimMode: true })` configuration, served with es-module-shims.

## The specs — one file per dimension of a `remoteEntry`

Pooling coordinates a *family* of externals — a monorepo's packages, which are only safe when they come
from one build. Two rules decide whether a remote may take the dedups the resolver granted it: a remote
that is version-incompatible on any member serves its whole family from its own build, and so does a
remote whose builds **disagree**, i.e. place a member they both ship on a different minor line.

| spec           | the dimension it varies                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `membership`   | what puts two externals in one family: npm scope, `pool` tag, `shareScope`, `singleton`, multiple entrypoints of one package                                              |
| `ranges`       | `version` / `requiredVersion` / `strictVersion`: what agreement tolerates (patch drift, ragged coverage, asymmetry, disjoint builds) and what it catches (minor gap, major gap, mutually exclusive pins) |
| `islands`      | the shape of the verdict: all-or-nothing, per remote, the shared set losing an island's sole-provided members, the cascade to a fixed point, host precedence, the feature-flag boundary |
| `cost`         | the copy-weighted download objective, `profile.latestSharedExternal`, tiebreaks, and a characterised residual (per-member elections can still split a pool)               |
| `chunks`       | the `chunks` field: chunk imports are scoped to the origin serving the file, so a deduped external's chunk graph still resolves                                            |
| `lifecycle`    | warm reload, incremental portfolios, the manifest-as-URL form, the dynamic path with both gates mirrored (plus a characterised **known defect**: the dynamic island is never persisted), and how the browser treats a second import map |
| `capture`      | the recorded portfolios in `fixtures/` — real entries, 6–37 externals each, partial tagging, a non-global share scope, one sparse-format entry — as the check that the rules compose on input nobody designed for them |

Two blocks are **characterisations**, not requirements — they pin current behaviour that is known to be
imperfect and reference the follow-up that owns it. A failure there is probably good news; read the
comment before "fixing" it.

Step-level guards live next to the steps under `src/lib/core/2.app/steps/`.
