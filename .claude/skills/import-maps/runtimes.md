# Multiple maps, es-module-shims, CSP and errors

## Contents
- Multiple and dynamic maps (native)
- Timing
- es-module-shims: polyfill mode vs shim mode
- Where es-module-shims differs from native
- CSP and Trusted Types
- Error and warning messages
- Browser support

## Multiple and dynamic maps (native)

Each window has one global map. Every `<script type="importmap">` merges into it when inserted, before, between
or after module loads (in browsers with multiple-map support). The page also keeps a set of every resolution so
far: (referrer, specifier) → URL, including URL-like specifiers and `import.meta.resolve` calls.

Merging a new map:

1. **Scopes:** for each new scope, drop any rule for a specifier already resolved by a referrer inside that scope
   (and prefix rules covering it). Merge the rest into the existing scope of the same key; on conflict the old
   value wins.
2. **Integrity:** old wins.
3. **`imports`:** drop rules for already resolved specifiers and their `/`-prefixes (Chromium: once
   `@fw/core/testing` resolved anywhere, a later top-level `@fw/`, `@fw/core/` and `@fw/core/testing` are dropped;
   `@fw/core` is dropped only if `@fw/core` itself resolved). Merge the rest; on conflict the old value wins.

Net effect: **first wins on every conflict, and nothing already resolved ever changes.** A later map can add new
keys, and it can add a scope that gives *new* referrers a different file.

Example (host page at `http://host/`, a late remote at `http://host/mfe2/`):

```
map 1: { "imports": { "@fw/core": "http://host/a/core.js" } }       // app.js has imported @fw/core
map 2: { "imports": { "@fw/core": "http://host/b/core.js", "@fw/ui": "http://host/b/ui.js" } }
→ @fw/core stays http://host/a/core.js (warning: rule removed), @fw/ui is added
map 2': { "scopes": { "http://host/mfe2/": { "@fw/core": "http://host/b/core.js" } } }
→ takes effect for files under http://host/mfe2/, as long as none of them resolved @fw/core yet
```

Removing a map element never unregisters it, natively or in es-module-shims: its rules stay merged. "Replacing"
a map by removing its element and inserting a new one does not work: the new map's conflicting keys lose.

## Timing

- An inline map registers **synchronously** on insertion: append it, then `import()` in the same task sees it.
- Resolution happens per module as each response arrives. A map inserted while a static graph is still loading
  affects only the specifiers not yet resolved; which ones depends on network timing (follows from the spec; not
  measured). Insert maps before starting the loads they are for.
- Browsers without multiple-map support accept a single map, only before any module load starts; later maps are
  ignored with a console error. That is why boot code that inserts the map must be a classic script: a
  `type="module"` boot script is itself a module load. Older guidance, MDN included, describes this single-map rule
  as universal.

## es-module-shims: polyfill mode vs shim mode

**Polyfill mode** (default) handles `type="importmap"` and `type="module"`.

- If the browser supports everything the page uses (import maps, multiple maps if there are several, no hooks, no
  external maps), it does nothing ("native passthrough"): native rules apply.
- Otherwise it re-runs only module graphs that failed at **link time**. You first see the native error, then
  `^^ Module error above is polyfilled and can be ignored ^^`. A failing dynamic `import()` is not polyfilled; use
  `importShim()`.
- A module that ran natively and is also loaded by the shim runs **twice** (typical for modules using `import()`
  reached from a polyfilled graph, or whenever a hook disables passthrough).
- Single-map browsers can diverge from no-map browsers: with map 1 `"a": "/a.js"` and map 2 scope
  `"/": {"a": "/b.js"}`, `import 'a'` loads `/a.js` in the first and `/b.js` in the second.

**Shim mode** is turned on by any `importmap-shim` / `module-shim` / `modulepreload-shim` element or by
`esmsInitOptions = { shimMode: true }`.

- Only the `-shim` types are processed. es-module-shims ignores native `importmap` tags, and the browser ignores
  `importmap-shim`, so the two never mix.
- Every module is loaded by the shim (rewritten, run from blob URLs); there is no native passthrough.
- Extras: external maps via `src` (relative entries resolve against that `src`), `importShim.getImportMap()`,
  `importShim.addImportMap(map)`, the `mapOverrides` option, and the `resolve` hook.
- `esmsInitOptions` must be set on `globalThis` **before** the es-module-shims script loads.
- New maps are noticed by a MutationObserver on `document` and `document.head` children only. A map appended to
  `<body>` is seen at the next `importShim()` call. Maps compose in discovery order; every load waits for them.

## Where es-module-shims differs from native

1. **No record of what was resolved.** Only exact key conflicts are checked when composing. A later map *can* add
   scope or prefix rules that change future resolutions of a specifier already resolved elsewhere.
2. **Key conflicts keep the old value and warn** `es-module-shims: Rejected map override "<key>" from <old> to <new>.`
   (not a throw). With `shimMode: true` **and** `mapOverrides: true`, the later map silently **wins**: the opposite
   of native. A test setup with `mapOverrides: true` cannot tell additive deltas from overriding ones.
3. **Spurious override warnings:** the old resolved URL is compared with the new *raw* string, so re-adding an
   identical map with relative values or URL-like keys still warns. Only absolute URLs on both sides compare equal.
4. **Integrity conflicts warn (`Rejected map integrity override`) but the new value wins.** Natively the old one
   does. Integrity is only enforced in shim mode or when the polyfill engages.
5. **`null` and non-string values are skipped**, so resolution falls through to outer scopes or `imports` instead
   of throwing.
6. **Values resolve through the previous map**, so a bare value `"a": "b"` works if `b` was mapped earlier. One that
   does not resolve is dropped with `es-module-shims: Mapping "<k>" -> "<v>" does not resolve`.

Scope lookup order itself matches the spec: longest matching scope, outer scopes, then `imports`.

**Diagnostics hook.** In shim mode es-module-shims resolves every import itself and accepts
`esmsInitOptions.resolve(id, parentUrl, defaultResolve)`. Wrapping `defaultResolve` to log a failing bare `id`
together with `parentUrl` names exactly which file's import broke. In polyfill mode the hook disables native
passthrough (risk of modules running twice); native maps have no hook.

## CSP and Trusted Types

- An inline import map is checked against `script-src` like any inline script: it needs a nonce, hash or
  `'unsafe-inline'`. A map built at runtime must get `script.nonce`; a blocked map fails silently and then every
  bare import fails. Exception: with `'strict-dynamic'`, a map inserted by an already trusted script (not
  parser-inserted) runs without a nonce. Measured in Chrome 155: `script-src 'nonce-x' 'strict-dynamic'` accepts
  the un-nonced runtime map; `script-src 'nonce-x'` and `script-src 'self' 'nonce-x'` block it.
- es-module-shims' default build is CSP-safe. It takes the nonce from the first script on the page or its `nonce`
  option. Under Trusted Types allow the policy `es-module-shims`. Workers need its non-CSP wasm build.

## Error and warning messages

| runtime | message | meaning |
| --- | --- | --- |
| Chromium, static import | `Failed to resolve module specifier "<s>". Relative references must start with either "/", "./", or "../".` | bare `s` unmapped from that referrer; nothing in the graph runs |
| Chromium, static import | `Failed to resolve module specifier "<s>". Import Map: "<s>" matches with "<key>" but is blocked by a null value` (or `... due to backtracking`, `... relative URL parse failure`) | entry exists but is `null`/invalid |
| Chromium, `import()` | `Failed to resolve module specifier '<s>'` | same; only that promise rejects |
| Chromium, map merge (warning) | `An import map rule for specifier '<k>' was removed, as it conflicted with an existing rule.` | later map lost to an earlier one (also logged when the value is identical) |
| Chromium, map merge (warning) | `... was removed, as it conflicted with already resolved module specifiers.` (also a `scope rule` variant) | later rule would change a resolution that already happened |
| Chromium, map parse | `Ignored an import map value of "<k>": Bare specifier: <v>` / `Ignored scope "<k>"` / `Failed to parse import map: invalid JSON` | entry nulled / scope dropped / whole map rejected |
| Firefox | `The specifier "<s>" was a bare specifier, but was not remapped to anything.` | unmapped bare specifier |
| Firefox | `Resolution of specifier "<s>" was blocked by a null entry.` | entry exists but is `null`/invalid |
| Firefox (warning) | `Multiple import maps are not allowed.` | a second map in a single-map browser; it is ignored entirely |
| Chromium / Firefox, map `integrity` | `Failed to find a valid digest in the 'integrity' attribute for resource '<url>' ...` / `None of the "sha384" hashes in the integrity attribute match ...` | hash mismatch; the module is blocked |
| Safari | `Module name, '<s>' does not resolve to a valid URL.` | unmapped bare specifier |
| es-module-shims | `Unable to resolve specifier '<s>' imported from <parentUrl>` | unmapped; `parentUrl` is the referrer to inspect |
| es-module-shims | `es-module-shims: Rejected map override "<k>" from <old> to <new>.` | later map lost (default config) |
| es-module-shims | `Unable to parse import map <msg> in: <text>` | invalid map JSON |

## Browser support

| feature | Chrome | Firefox | Safari |
| --- | --- | --- | --- |
| import maps | 89 | 108 | 16.4 |
| multiple / dynamic maps | 133 | 150, behind the `dom.multiple_import_maps.enabled` pref (bug 1916277) | 18.4 |
| `integrity` in the map | 127 | 138 | 18 |
| `import.meta.resolve` | 105 | 106 | 16.4 |

Feature test: `HTMLScriptElement.supports('importmap')`. No feature test exists for multiple-map support; assume
a single map unless every supported browser has it. Firefox 150.0.2 and 155 still ignore a second map by default
(`Multiple import maps are not allowed.`) and merge like Chrome once the pref is on (measured 2026-10).

Check current support before relying on a version: [import maps](https://caniuse.com/import-maps),
[multiple import maps](https://caniuse.com/mdn-html_elements_script_type_importmap_multiple_import_maps),
[`integrity`](https://caniuse.com/mdn-html_elements_script_type_importmap_integrity).
