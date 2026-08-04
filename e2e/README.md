# End-to-end suite

```
npm run test-e2e            # the whole suite
npx playwright test -c e2e/playwright.config.ts symmetric  # one file
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
| which build a remote runs | every remote's exposed module statically imports **every entrypoint its remoteEntry declares** and reports what each one resolved to (`nf.load`, `nf.loadAll`); chunk specifiers are probed with `nf.resolve` instead, since a chunk is not an entrypoint |
| the real download cost    | files the HTTP server actually served (`nf.downloads`, `nf.fetches`, `nf.chunkLoads`), and copies the page actually evaluated (`nf.copies`, `nf.buildsOf`) |
| a warm start             | `nf.init` is a page load; calling it twice against the same `sessionStorage` is the refresh a user gets                            |

A test that merely loads is already meaningful: if the map failed to cover an entrypoint some remote
declared, the static import throws and the test fails.

## The harness

`harness/` is the whole apparatus, in five pieces:

- **`portfolio.ts`** — the declaration layer. `dep()` / `remote()` / `withChunks()` build `remoteEntry`
  documents and `shape()` re-renders one into any of the four vendor shapes; `fixture()` and
  `poolFixture()` load a recorded one from [`fixtures/`](fixtures/README.md). `SCOPE` holds the origins the
  specs use, `mfe1`–`mfe5`, numbered in the order a portfolio declares them and carrying no meaning of
  their own.
- **`server.ts`** — one HTTP server that dispatches on the `Host` header, and compiles a portfolio into
  the files a browser needs: each `remoteEntry.json`, one ES module per declared entrypoint, one per
  exposed module, one per chunk. Chromium is launched with `--host-resolver-rules=MAP * 127.0.0.1:<port>`,
  so `http://mfe1/` really is a separate origin to the browser — real CORS, real `Referer`, real
  import-map scope matching. The generated externals record themselves in `globalThis.__nfCopies` on
  evaluation, which is how copy counts are measured rather than inferred.
- **`boot.ts`** — runs in the page, bundled by esbuild straight from `src/lib`. Exposes `initFederation`
  and a few readers (`maps`, `load`, `resolve`, `copies`, `storage`) on `window.__nfe2e`. Loaded as a
  **classic** script on purpose: a `type="module"` boot would itself be a module load, and a native
  import map has to be installed before the first one.
- **`federation.ts`** — the Playwright fixture. Server and browser are worker-scoped, `nf` is per test.
- **`coherence.ts`** — the measures taken off a whole portfolio rather than one external: which tag each
  external is still shared at, which packages ended up split across two tags, which Angular minor lines
  each remote's code actually holds.

Native import maps are the default. `{ shim: true }` switches a test to the
`useShimImportMap({ shimMode: true })` configuration, served with es-module-shims.

## The specs — one file per permutation of the feature

Pooling coordinates a *family* of externals — a monorepo's packages, which are only safe when they come
from one build. Two gates decide whether a remote may take the dedups the resolver granted it: a remote
that is version-incompatible on any member serves its whole family from its own build, and so does a
remote for which no single build ships every specifier it imports at versions it accepts.

The files are organized by what the *portfolio* looks like, not by which field of a `remoteEntry` it uses,
because that is what decides the verdict: whether the remotes of a family declare the same members, and
which shape the build emitted them in.

| spec            | the permutation it covers                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flag`          | **the only file that switches `useAutoExternalPooling`.** One portfolio, flag on and off: the split family it prevents, the sibling it stops bridging, the two-major shared set it repairs, the dynamic path, what it costs (one download on the minimal case, nothing on the capture), and the boundary — a `pool` tag works with auto-pooling off, entrypoint coverage is decided identically either way |
| `membership`    | what puts two externals in one family: npm scope, `pool` tag, `shareScope`, `singleton`, multiple entrypoints of one package                                                                                                                                                          |
| `symmetric`     | **families whose remotes declare the same members**, so only version lines differ: patch drift, minor gap, major gap, mutually exclusive pins, a 2-2 split with no majority, all-or-nothing islanding, host precedence, and the copy-weighted election (`profile.latestSharedExternal`, tiebreaks) |
| `asymmetric`    | **families whose remotes declare different members**: containment, ragged coverage, disjoint builds, sole-provided members and entrypoints leaving the shared set with their island, the cascade to a fixed point, and a characterised residual (per-member elections can still split a pool) |
| `entrypoints`   | asymmetry inside one package — the `entries` field: widest-remote basis, sibling self-fill and what it costs in builds on the page, `profile.scopeUncoveredEntrypoints`, a remote joining an already-resolved version. A **resolver** policy, not a pooling one                          |
| `vendor-shapes` | **the four shapes a build emits**: externals dense (`entries`) or flat (one element per entrypoint), × chunking dense (a `chunks` property) or flat (`@nf-internal/chunk-*` pseudo-externals). The verdict is shape-invariant; where the shape does show through — `feature.convertFlatSharedInfo`, and chunks mapped per declaring vs serving remote — it is pinned exactly |
| `lifecycle`     | warm reload, incremental portfolios, the manifest-as-URL form, the dynamic path with both gates mirrored (plus a characterised **known defect**: the dynamic island is never persisted), and how the browser treats a second import map |
| `capture`       | the recorded portfolios in `fixtures/` — real entries, 6–37 externals each, a non-global share scope, two in the older flat format — as the check that the rules compose on input nobody designed for them |

Two blocks are **characterisations**, not requirements — they pin current behaviour that is known to be
imperfect and reference the follow-up that owns it. A failure there is probably good news; read the
comment before "fixing" it.

Step-level guards live next to the steps under `src/lib/core/2.app/steps/`.
