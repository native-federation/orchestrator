# Resolution in detail (native browsers)

es-module-shims deviations are in [runtimes.md](runtimes.md).

## Contents
- Bare vs URL-like specifiers
- Parsing the map
- The algorithm
- Prefix keys and `null` entries
- What counts as the referrer
- Module identity
- Integrity
- Where import maps do not apply

## Bare vs URL-like specifiers

- A specifier starting with `/`, `./` or `../` is parsed as a URL against the referrer. That includes `//cdn/x.js`,
  which can switch host.
- Otherwise it is parsed as an absolute URL (`http://...`, `data:...`). If that fails, it is **bare**:
  `@fw/core`, `foo/bar.js` and even `x.js` are bare.
- URL-like specifiers are looked up by their canonical absolute URL, so a key can remap real URLs. Bare
  specifiers are looked up as literal strings.
- If nothing maps a URL-like specifier, it loads its own URL. If nothing maps a bare one, it throws.

## Parsing the map

- **Keys** (in `imports` and inside scopes): URL-like keys become absolute URLs against the map's base URL; any
  other key stays a literal string. An empty key is dropped with a warning.
- **Values** must be URL-like and are resolved against the map's **base URL**, never against the scope. For an
  inline map the base URL is the document's (`<base href>` applies). A bare value, a non-string value, or a
  trailing-slash key with a value lacking a trailing slash is stored as `null`, with a console warning
  (Chromium: `Ignored an import map value of "<key>": Bare specifier: <v>` or `...: Invalid value type.` for
  `null`; Firefox: `Addresses need to be strings.`).
- **Scope keys** are parsed as URLs against the base URL: `"mfe1/"` means `<document dir>/mfe1/`, `"/mfe1/"` means
  the page's origin. A cross-origin remote needs an absolute scope key. An unparsable key is dropped
  (Chromium: `Ignored scope "<key>"`).
- **Only structural errors reject the whole map**, thrown at registration: invalid JSON (`SyntaxError`), or
  (`TypeError`) a non-object top level, `imports` / `scopes` / `integrity` or a scope value that is not an object. Everything else is a warning
  and the entry is dropped or nulled. Unknown top-level keys only warn.
- `src` is not supported: `<script type="importmap" src>` fires `error` and is ignored.
- Editing a map element's text after insertion does nothing; insert a new element.

## The algorithm

For specifier `s` imported by a module whose base URL is `R`:

1. For each scope key, sorted descending by code units (so longest first among matches): if the key equals `R`,
   or ends in `/` and is a prefix of `R`, run the imports-match below on that scope. A result returns; a throw
   stops everything; no match moves to the next scope.
2. Run the imports-match on `imports`.
3. Still nothing: a URL-like `s` resolves to its own URL; a bare `s` throws.

Imports-match, for each key sorted descending (longest first):

- Exact key match → its URL, or throw if the value is `null`.
- Prefix match (key ends in `/`, is a prefix of `s`, and `s` is bare or an http/https/file-like URL) → parse the
  remainder of `s` against the value. Throw if the value is `null`, the parse fails, or the result climbs out of the
  value's directory (`..`).

Example. Map on `http://host/index.html`:

```json
{ "imports": { "a": "http://host/a-1.js" },
  "scopes": { "http://host/s2/": { "a": "http://host/a-2.js" },
              "http://host/s2/s3/": { "b": "http://host/b-3.js" } } }
```

| referrer | import | result |
| --- | --- | --- |
| `http://host/s2/s3/r.js` | `b` | `http://host/b-3.js` (innermost scope) |
| `http://host/s2/s3/r.js` | `a` | `http://host/a-2.js` (falls through to the outer scope) |
| `http://host/x.js` | `a` | `http://host/a-1.js` |
| `http://host/s2` | `a` | `http://host/a-1.js` (`http://host/s2/` is not a prefix of `http://host/s2`) |

## Prefix keys and `null` entries

- `"pkg"` and `"pkg/"` are independent. Map both for a package with subpaths.
- With `"@fw/": "http://cdn/fw/"`: `@fw/core/x.js` → `http://cdn/fw/core/x.js`; `@fw/../evil.js` throws
  (backtracking).
- Prefix keys never match `data:` or `blob:` specifiers; only exact keys do.
- A `null` entry in the most specific matching scope throws; it does **not** fall back to outer scopes or
  `imports`. Use it on purpose to block a package for one subtree; beware that a typo in a value has the same
  effect.

## What counts as the referrer

- For an external module script: its **response URL** (after redirects). For an inline module, or `import()` from a
  classic script or event handler: the document's base URL.
- **Redirects split identity from scoping.** The module map is keyed by the *request* URL, but scopes match the
  *response* URL. If `http://host/mfe1/entry.js` redirects to `http://cdn/mfe1-v2/entry.js`, its imports no longer
  see the `http://host/mfe1/` scope and fall back to `imports`, and importing the response URL directly gives a
  second instance (measured in Chrome 155 and Firefox 150/155).
- `data:` and `blob:` modules match no http scope (only `imports` applies) and cannot use relative specifiers
  (`Invalid relative url or base scheme isn't hierarchical.`).
- `import.meta.resolve(s)` runs the same algorithm with the module as referrer and returns what a static import
  would load. It also counts as a resolution for merging: it locks `s` against later maps even if nothing loads.

## Module identity

- The module map is keyed by (request URL, module type). Two different URLs are two instances, even if only a
  `?query` or `#hash` differs. Two scopes mapping a specifier to the **same** URL share one instance.

## Integrity

- The map's `integrity` object is keyed by URL (URL-like keys only) and applies to any module fetched at that URL,
  mapped or not, unless the fetch already carries its own integrity.
- Between maps, the first integrity value for a URL wins natively.

## Where import maps do not apply

- Workers and worklets: a module worker importing `@fw/core` throws. es-module-shims in shim mode inside the worker
  is the workaround.
- Shadow DOM: there is no per-component map. A `<script type="importmap">` appended to a shadow root registers into
  the window's global map like any other (Chrome 155, Firefox 155), so a web component isolates its dependencies
  only through a scope keyed by its URL.
- `<script src>`, `new Worker(url)`, `<link rel=modulepreload href>` take URLs, not specifiers. The `integrity` map
  does apply to preloads.
