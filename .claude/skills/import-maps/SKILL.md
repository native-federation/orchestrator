---
name: import-maps
description: Explains how browser import maps really resolve modules (scopes, fallback order, merging of multiple maps, module identity per URL) in native browsers and es-module-shims, with the quirks and failure modes, and how nf-orchestrator generates its maps for native federation. Use when reading, writing, generating or debugging an import map, `<script type="importmap">` or `importmap-shim`, scopes, bare specifiers, dynamically added maps, or errors such as "Failed to resolve module specifier", "Unable to resolve specifier", "Rejected map override", or a shared package loading twice (e.g. Angular NG0203) in a micro-frontend page, and when changing nf-orchestrator's import-map, pooling, serving-build or dynamic-init code.
---

# Import maps

## The model

1. **A bare import resolves from the URL of the file that contains it** (the *referrer*), never from the app or
   remote that started the import chain. The browser has no notion of "which remote this module is for".
2. **Lookup order:** every scope whose key matches the referrer, most specific first, then `imports`. A matching
   scope that lacks the specifier falls through to the next one. A match whose value is `null` or invalid throws
   with no further fallback. No match for a bare specifier is an error.
3. **A scope key matches** when it equals the referrer URL exactly, or ends in `/` and is a string prefix of it.
4. **One module instance per URL.** The same package at two URLs is two instances: two singletons, two DI
   containers, two `instanceof` worlds.
5. **All maps on a page merge into one, first wins.** A later map can add keys and scopes, but never repoint an
   existing key, nor change anything already resolved. es-module-shims can behave differently; see
   [runtimes.md](runtimes.md).

## Worked example

Host page at `http://host/`, remote `mfe1` at `http://mfe1/`. The map:

```json
{
  "imports": { "ui": "http://mfe1/ui.js", "rxjs": "http://host/rxjs-7.js" },
  "scopes": { "http://mfe1/": { "rxjs": "http://mfe1/rxjs-6.js" } }
}
```

| importing file | import | resolves to | why |
| --- | --- | --- | --- |
| `http://host/app.js` | `ui` | `http://mfe1/ui.js` | no scope matches the host; `imports` |
| `http://host/app.js` | `rxjs` | `http://host/rxjs-7.js` | `imports` |
| `http://mfe1/ui.js` | `rxjs` | `http://mfe1/rxjs-6.js` | the file lives under `http://mfe1/` |
| `http://mfe1/ui.js` | `lodash` | error | no scope or `imports` entry |

The host asked for `ui`, but `ui`'s own imports bind where `ui` lives: the page now runs two rxjs instances.
Scoping a dependency for one remote never reaches files that remote loads from other URLs, and serving a shared
file from a remote drags that remote's scope onto every consumer.

## Keys and values

- `pkg` and `pkg/` are separate keys: `"pkg"` alone does not map `pkg/sub.js`; `"pkg/"` alone does not map `pkg`.
  A trailing-slash key needs a trailing-slash value.
- Values must be URLs (absolute, or starting with `/`, `./`, `../`). A bare value becomes a `null` entry, which
  then *blocks* that specifier natively.
- Relative values and scope keys resolve against the **map's base URL** (the document), not against the scope:
  on `http://host/shell/index.html`, `"scopes": {"http://mfe1/": {"a": "./a.js"}}` maps `a` to
  `http://host/shell/a.js`. Generate absolute URLs.
- Bare specifiers are matched literally (`@fw/core` ≠ `@fw/core/`); URL-like specifiers and keys are canonicalized
  first, so from `http://host/index.html` the key `"/js/app.js"` also catches `./foo/../js/app.js`.
- When several keys match, the longest (most specific) wins, for both scopes and prefix keys.

Full algorithm, redirects, `import.meta.resolve`, workers, integrity: [resolution.md](resolution.md).

## Writing and inserting a map

- **Inline only.** A map is the JSON text of a `<script type="importmap">`. Natively `src` is not supported
  (only es-module-shims shim mode loads external maps), and editing the element's text after insertion does
  nothing: to change the page's map, insert another element.
- **Build it at runtime** as a classic script appended to `document.head`:
  `Object.assign(document.createElement('script'), { type: 'importmap', nonce, textContent: JSON.stringify(map) })`.
  Under a nonce-based CSP the map needs the nonce like any inline script (a blocked map fails silently, then every
  bare import fails); only `'strict-dynamic'` lets a map created by an already trusted script through without one.
  Under Trusted Types the text goes through a policy. Use absolute URLs for every value and scope key.
- **Insert it before the loads it is for.** Browsers without multiple-map support take one map, and only before
  the first module load; boot code that inserts it must therefore be a classic script. Feature test:
  `HTMLScriptElement.supports?.('importmap')`.
- **Outdated guidance is common.** Older guidance, MDN included, says a map must precede every module script and
  that later maps are ignored. That is single-map behaviour; with multiple-map support, maps merge at any time
  ([runtimes.md](runtimes.md#multiple-and-dynamic-maps-native)). Don't rewrite working code to the old rule, and
  don't rely on the new one where single-map browsers must work.
- **One map per window.** A map placed in a shadow root still registers, but into the window's global map, so a
  web component cannot isolate itself with its own map; workers ignore the page's map. Isolate a remote with a
  scope keyed by its URL.

## Gotcha checklist

Run through this when a map misbehaves or before shipping a map generator change:

- [ ] Is every bare specifier each **served file** imports mapped from **that file's URL** (its own scope, outer
      scopes, or `imports`)? Check transitive imports, not just the entry specifiers.
- [ ] Does a scope map only *some* entrypoints of a package? The rest fall through to `imports` and come from
      another build.
- [ ] Do two URLs on the page serve the same package? Expect two instances. That includes URLs that differ only
      by a cache-busting `?query` or `#hash`.
- [ ] Do build-internal chunk specifiers (same name, different builds) sit only in their owner's scope?
- [ ] Do scope keys end in `/`? Without it a key matches one exact URL.
- [ ] Are all values absolute URLs? Relative ones resolve against the document, not the remote.
- [ ] Does a later map try to change a key the page already has? It is dropped (native: warning; default
      es-module-shims: `Rejected map override`). Give the newcomer a scope instead.
- [ ] Is the map inserted before the first module load (needed in browsers without multiple-map support), as an
      inline script carrying the CSP nonce (unless the policy has `'strict-dynamic'`)?
- [ ] Does a remote URL redirect? Scopes match the *response* URL, so the remote's scope stops applying to the
      redirected file, while the module instance stays keyed by the request URL.
- [ ] Is code running in a worker? Import maps do not apply there.
- [ ] Is it native or es-module-shims, which mode, with `mapOverrides`? The answer changes merge behaviour.

## Diagnosing a failure

| symptom | meaning | first check |
| --- | --- | --- |
| `Failed to resolve module specifier "x"`, `Unable to resolve specifier 'x' imported from <url>` (others in [runtimes.md](runtimes.md#error-and-warning-messages)) | No entry reachable from that referrer | The referrer URL (es-module-shims names it): which scopes match it? |
| `... matches with "<key>" but is blocked by a null value` | `null`/invalid value (often a bare or relative value) | The value in the most specific matching scope |
| `An import map rule for specifier 'x' was removed, as it conflicted with ...` (Chromium warning) | A later map tried to change an existing or already-resolved key | Map order; use a scope for the newcomer |
| `es-module-shims: Rejected map override "x" from A to B.` | Same, in es-module-shims | Same |
| Page renders but a framework says it is outside an injection context / two instances | One package loaded from two URLs | Walk the page (below this table) |
| `Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"` (Firefox: `Loading module from "<url>" was blocked because of a disallowed MIME type ("text/html")`); the `import()` itself only rejects with `Failed to fetch dynamically imported module: <url>` (Firefox: `error loading dynamically imported module: <url>`) | Resolution worked, but the URL served no JS: usually a 404 page or an SPA fallback to `index.html` | Open the resolved URL; check the value's path and trailing slash |
| `... has been blocked by CORS policy` on a module | Resolution worked; the cross-origin fetch failed | `Access-Control-Allow-Origin` on the remote's responses |
| Feature silently never runs | A dynamic `import()` failed and was swallowed | Resolve the specifier from that file's URL |

A static import that fails to resolve fails the whole module graph above it; a failing `import()` only rejects
its promise. Resolve failures usually log nothing else.

To verify a map, walk the page: resolve each file's imports from that file's URL, transitively, starting from every
app and remote (method in [shared-dependencies.md](shared-dependencies.md#judging-a-map)). In a running page, prove
a resolution by importing the specifier from a module served under the referrer's URL and catching the rejection,
or by calling `import.meta.resolve(s)` there, which returns the URL without loading it but natively locks `s`
against later maps (keep it out of code that runs before maps are added). Count instances by what was evaluated,
not by reading the map.

## Reference files

- [resolution.md](resolution.md): the full resolution algorithm, key/value normalization, prefix keys, `null`
  entries, redirects, `data:`/`blob:` referrers, `import.meta.resolve`, workers, integrity.
- [runtimes.md](runtimes.md): multiple and dynamic maps, merge rules and timing, es-module-shims polyfill vs shim
  mode and where it differs from native, CSP, error messages, browser support (with caniuse links).
- [shared-dependencies.md](shared-dependencies.md): sharing packages between independently built apps through one
  map: mixed builds, chunks, scope leaks, fallback units, the host gap, how to judge a map.
- [orchestrator.md](orchestrator.md): how nf-orchestrator builds its maps (record, one serving build per
  package, pooling, named and strict share scopes, dynamic loads) and the hazards to check when changing that code.
