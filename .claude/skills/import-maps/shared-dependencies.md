# Sharing packages between independently built apps

Setting: a **host** page and several **remotes** (micro-frontends), each built separately and served from its own
base URL (`http://host/`, `http://mfe1/`, ...). Each remote's files live under its base URL, and the map gives each
remote a scope keyed by that URL. A **build** is what one remote ships of a package; a package has **entrypoints**:
its root (`@fw/core`) and secondaries (`@fw/core/testing`). Sharing means pointing several remotes at one file.

## Contents
- Same version is not the same files
- Chunks: build-internal specifiers
- Partial scopes stitch silently
- Scope leaks through served files
- The fallback unit is the family
- The host gap
- Judging a map

## Same version is not the same files

Two builds of `@fw/core@1.0.0` can ship different file sets and different entrypoint lists. Mixing files of one
package from two builds (a **stitch**) is a defect even when no error appears; when it duplicates the package's
internal state it **tears** (two instances of state that must be single). Check per **package**, not per
specifier: `@fw/core@1.0.0` from the map beside `@fw/core/testing@1.0.1` from a scope is two cores even though each
specifier on its own looks fine. Version equality never makes mixing safe.

## Chunks: build-internal specifiers

Bundlers split code shared by several entrypoints into chunks that entrypoints import by a bare specifier, e.g.
`@nf-internal/chunk-core`. Different builds emit the **same** chunk specifier for different files.

```json
{ "imports": { "@fw/core": "http://a/core.js", "@fw/core/interop": "http://b/interop.js" },
  "scopes": { "http://a/": { "@nf-internal/chunk-core": "http://a/chunk-core.js" },
              "http://b/": { "@nf-internal/chunk-core": "http://b/chunk-core.js" } } }
```

`http://b/interop.js` binds `b`'s chunk, `http://a/core.js` binds `a`'s: two copies of core's internals on one
page. In Angular this shows as `NG0203` (`inject()` / `toSignal()` outside an injection context). Rules:

- Map chunk specifiers only in the owning build's scope, never in `imports`.
- Never borrow one entrypoint of a chunked package from another build.
- A scoped entrypoint needs its build's chunks mapped in a scope covering its URL, or it fails with
  `Unable to resolve specifier '@nf-internal/chunk-…' imported from http://b/interop.js`.

## Partial scopes stitch silently

Scopes fall through. A scope that maps some entrypoints of a package lets the rest resolve from `imports`:

```json
{ "imports": { "@fw/core": "http://host/core.js", "@fw/core/testing": "http://host/testing.js" },
  "scopes": { "http://mfe1/": { "@fw/core": "http://mfe1/core.js" } } }
```

Files under `http://mfe1/` get their own `@fw/core` but the host's `@fw/core/testing`, which itself binds the
host's core. No error; two builds. Swap a package for a remote with **all** its entrypoints, or not at all.

Entrypoints also import each other. A borrowed `pkg/b` from build B reaches `pkg/a` through B's URL, so one
borrowed sibling pulls in a second build even when the remote's own `pkg/a` is mapped.

## Scope leaks through served files

Even with one build per package, scopes leak, because a served file resolves through the scope of **its** URL.

**Provider-scope leak.** Host at `http://host/`, remote `w` at `http://w/`; `w` serves `@fw/core` to everyone and
privately uses rxjs 6:

```json
{ "imports": { "@fw/core": "http://w/core.js", "rxjs": "http://host/rxjs-7.js" },
  "scopes": { "http://w/": { "rxjs": "http://w/rxjs-6.js" } } }
```

The host's code uses rxjs 7, but `http://w/core.js` (loaded for the host) binds rxjs 6. Two rxjs instances; core
sees one, the app the other. Changing which remote serves a package also changes which scope comes with it.

**Consumer-scope leak.** The reverse. Remote `r1` at `http://r1/` scopes its own `dep` 1.1 and imports the shared
`m0`, which the host serves:

```json
{ "imports": { "m0": "http://host/m0.js", "dep": "http://host/dep-1.0.js" },
  "scopes": { "http://r1/": { "dep": "http://r1/dep-1.1.js" } } }
```

`http://r1/app.js` gets `dep` 1.1, but `http://host/m0.js` (imported by r1) gets `dep` 1.0. A remote's scope never
reaches files at other URLs.

A sufficient check: a provider is leak-free when every bare import of every file it serves resolves to the same URL
from its own scope as from each consumer's referrer. Checking that needs the files' real imports, not just declared
packages.

## The fallback unit is the family

When a remote cannot use the shared copy of a package, giving it only that package from its own build is a tear one
level up: shared files of *other* packages still bind the shared copy. Example: the host serves
`@fw/core` and `@fw/platform`; a remote gets its own `@fw/core` in its scope but still uses the host's
`@fw/platform`. The host's platform file binds the host's core while the remote's components use the remote's
core (Angular: `NG0203`, `NG0201 No provider for NgZone`, blank remotes). Falling back the whole coupled family
(`@fw/*`) from the remote's own build works. A component handed across families (one framework's router
rendering another instance's component) still breaks; falling back a whole family does not make that safe.

## The host gap

The host's files live at the host URL and cannot be moved into another scope. If the host's build lacks an
entrypoint its own files import, the options are bad: leave it unmapped (the host fails loudly with an unresolved
specifier) or map another build's copy (a silent stitch). Typical causes at build time: a shared secondary was
explicitly excluded while another shared package imports it statically (blank page), or a secondary reached only
through a dynamic `import()` was pruned as unused (the error can be swallowed and a feature silently never runs).
Catch these at build time: lex every emitted file and report each bare import that the build's own shared
entrypoints and chunk names cannot resolve, marking dynamic ones.

## Judging a map

Walk the page, don't compare version tags:

1. For each remote (host included), start at its base URL and resolve every specifier it uses.
2. For each file reached, resolve that file's imports from its own URL: its chunks, its sibling entrypoints, other
   packages.
3. Per remote, report **unresolved** (`<file> -> <specifier>`), **twice** (one specifier reaches two URLs), **torn**
   (one package's internals from two builds), **stitched** (one package's files from two builds).

A model without real import edges has to over-approximate (each entrypoint imports all siblings its build ships)
and cannot see cross-package leaks. It also misses what only the browser shows: 404s, CORS, evaluation order and
lazily imported entrypoints. Compare an old and a new map per case and in more than one registration order:
totals hide one fix traded for one new fault, and order dependence is itself a bug signal.
