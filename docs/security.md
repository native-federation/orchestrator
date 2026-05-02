[< back](./../README.md)

# Security

The orchestrator ships two complementary security features:

1. [**Trusted Types**](#trusted-types) — wraps the orchestrator's two DOM sinks (the injected `<script type="importmap">` and the dynamic `import()` call) in a vetted policy so raw strings never reach a script-execution sink.
2. [**Subresource Integrity (SRI)**](#subresource-integrity) — verifies the bytes of the manifest, every `remoteEntry.json`, and every JavaScript module the import map points at against the SHA hashes published by the build.

The two features layer cleanly: Trusted Types makes sinks structurally safe, while SRI makes the data flowing through them tamper-evident.

## <a id="trusted-types"></a> Trusted Types

The orchestrator is compatible with the browser [Trusted Types](https://www.w3.org/TR/trusted-types/) API. When the host application enables Trusted Types via Content Security Policy, the orchestrator's two DOM sinks — the `<script type="importmap">` it injects and the dynamic `import()` it uses to load remote modules — flow through a vetted policy instead of writing raw strings.

### What the orchestrator protects

The library has two places where externally-fetched data reaches a script-execution sink:

| Sink                                          | Source of the data                            | Trusted type      |
| --------------------------------------------- | --------------------------------------------- | ----------------- |
| `<script type="importmap">` content (`replaceInDOM`) | Resolved import map built from `remoteEntry.json` files | `TrustedScript`   |
| Dynamic `import(url)` (`loadModuleFn`)        | Module URLs declared by remotes               | `TrustedScriptURL` |

Both go through a single Trusted Types policy named `nfo` by default. The policy applies two checks:

- **`createScript`** — re-parses the input and verifies it is a valid import map (a plain object with only `imports`, `scopes`, or `integrity` keys). Rejects anything else with a `TypeError`.
- **`createScriptURL`** — verifies the input parses as a URL with an `http:` or `https:` protocol. Rejects `javascript:`, `data:`, and malformed URLs.

On browsers without Trusted Types (and in test environments such as jsdom) the wrapper is a transparent pass-through, so the library behaves identically to a non-Trusted-Types build.

### Recommended CSP

For a host that wants Trusted Types enforced and uses the orchestrator's defaults:

```
Content-Security-Policy: require-trusted-types-for 'script'; trusted-types nfo
```

If the host registers its own policies in addition to `nfo`, list them all (and add `'allow-duplicates'` if a name is registered more than once):

```
Content-Security-Policy: require-trusted-types-for 'script'; trusted-types nfo my-host-policy 'allow-duplicates'
```

#### Phased rollout

Trusted Types is best deployed in stages. Start in report-only mode to surface every violation without breaking the page:

```
Content-Security-Policy-Report-Only: require-trusted-types-for 'script'; trusted-types nfo; report-uri /csp-reports
```

Once the report stream is empty, switch to the enforcing header above.

### Configuration

The Trusted Types policy is part of the [import-map configuration](./config.md#importMapConfig) and exposes a single option, `trustedTypesPolicyName`.

```javascript
import { initFederation } from '@softarc/native-federation-orchestrator';

initFederation('http://example.org/manifest.json', {
  // default
  trustedTypesPolicyName: 'nfo',
});
```

#### Renaming the policy

If your CSP `trusted-types` allowlist uses different names (for example to keep a project-wide naming convention), rename the orchestrator's policy:

```javascript
initFederation('http://example.org/manifest.json', {
  trustedTypesPolicyName: 'my-app-nfo',
});
```

```
Content-Security-Policy: require-trusted-types-for 'script'; trusted-types my-app-nfo
```

#### Opting out

Set the option to `false` when the host already wraps the import map and module URLs through its own policy (for example by overriding `setImportMapFn` and `loadModuleFn`):

```javascript
initFederation('http://example.org/manifest.json', {
  trustedTypesPolicyName: false,
  setImportMapFn: myHostsTrustedSetImportMap,
  loadModuleFn: myHostsTrustedImport,
});
```

With `trustedTypesPolicyName: false` the orchestrator will not call `trustedTypes.createPolicy` at all — useful when the CSP allowlist does not include `nfo` or when a `default` policy is already in place site-wide.

### Caveats

- **Default policy.** The orchestrator does not register a `default` policy. If your host uses one, the host's `default` policy is also consulted whenever a raw string reaches a sink — make sure it is compatible with the import-map and remote-URL data the orchestrator produces, or override the relevant functions.
- **Custom `setImportMapFn` / `loadModuleFn`.** The Trusted Types policy is only active inside the orchestrator's *default* implementations. When you supply your own functions you are responsible for producing trusted values yourself; setting `trustedTypesPolicyName: false` documents that intent.
- **Browser support.** Trusted Types is part of the 2026 Baseline (Chromium 83+, WebKit 26+, Gecko 148+). On older browsers the orchestrator's policy wrapper is a no-op, so existing deployments keep working without modification.
- **Policy ≠ sanitizer.** Trusted Types makes sinks structurally safe by funnelling all writes through a single, auditable choke point. The validators shipped with the orchestrator only check shape (JSON structure, URL protocol) — they are not a substitute for end-to-end controls on which manifests and remote origins your host trusts in the first place.

## <a id="subresource-integrity"></a> Subresource Integrity

The orchestrator can verify the bytes of every artifact it touches against an SRI-style hash before they are used. Verification is **opt-in per resource**: provide a hash and the bytes are checked, omit the hash and the resource is fetched as-is. This mirrors how the browser's `<script integrity="…">` attribute works.

### What can be pinned

| Resource | Where the hash lives | Verified by |
| --- | --- | --- |
| `manifest.json` | `manifestIntegrity` option on `initFederation` | Manifest provider hashes the response bytes before parsing |
| Each `remoteEntry.json` | `integrity` field on the manifest entry, or `hostRemoteEntry.integrity` | Remote-entry provider hashes the response bytes before parsing |
| Every shared external, exposed module, and chunk file | `integrity` map on `remoteEntry.json` (emitted by `@softarc/native-federation` when the build uses `integrity: true`) | Browser / `es-module-shims` honors the `integrity` block of the generated import map |

These three layers form a trust chain: pinning the manifest pins which `remoteEntry.json` files are trusted, each of which pins the modules the page actually executes.

### Module & chunk integrity (import map)

When `@softarc/native-federation` is built with `integrity: true`, the generated `remoteEntry.json` carries a top-level `integrity` map keyed by `outFileName`:

```json
{
  "name": "team/mfe1",
  "exposes": [{ "key": "./Button", "outFileName": "button.js" }],
  "shared": [
    { "packageName": "react", "outFileName": "react.js", "version": "18.2.0", … }
  ],
  "chunks": { "browser-react": ["chunk-ABCD1234.js"] },
  "integrity": {
    "button.js": "sha384-…",
    "react.js": "sha384-…",
    "chunk-ABCD1234.js": "sha384-…"
  }
}
```

The orchestrator copies these hashes onto every URL it emits and writes the result into the `integrity` block of the import map it injects into the DOM:

```html
<script type="importmap">
{
  "imports": {
    "team/mfe1/./Button": "https://mfe1.example.org/button.js",
    "react":              "https://mfe1.example.org/react.js"
  },
  "scopes": {
    "https://mfe1.example.org/": {
      "@nf-internal/chunk-ABCD1234": "https://mfe1.example.org/chunk-ABCD1234.js"
    }
  },
  "integrity": {
    "https://mfe1.example.org/button.js":            "sha384-…",
    "https://mfe1.example.org/react.js":             "sha384-…",
    "https://mfe1.example.org/chunk-ABCD1234.js":    "sha384-…"
  }
}
</script>
```

URLs without a hash are simply omitted from the `integrity` block (matching the SRI spec).

**Enforcement** depends on the import-map runtime:

- With `useShimImportMap()` ([es-module-shims](https://www.npmjs.com/package/es-module-shims)) the `integrity` block is fully enforced — modules with a mismatched hash fail to load.
- With `useDefaultImportMap()` (native browser `import()`) the `integrity` block is enforced by browsers that ship the [import-map `integrity` key](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap#integrity), now part of the [WHATWG HTML spec](https://html.spec.whatwg.org/multipage/webappapis.html#normalizing-a-module-integrity-map) ([whatwg/html#10269](https://github.com/whatwg/html/pull/10269), merged May 2024). Available in Chrome/Edge 127+, Firefox 138+, and Safari 18+. On older browsers the block is silently ignored, so the import map remains backwards-compatible.

### Pinning `remoteEntry.json` and `manifest.json`

`remoteEntry.json` and `manifest.json` are fetched as JSON, not as scripts, so SRI's `<script integrity>` attribute does not apply. The orchestrator instead computes a SHA-256 / SHA-384 / SHA-512 digest of the response bytes itself (`crypto.subtle.digest`) and compares it to the hash you provide. A mismatch rejects with an `NFError`.

#### Per-remote integrity in the manifest

A manifest entry can be either the existing string form or a `{ url, integrity }` object — they coexist freely:

```json
{
  "team/mfe1": "https://mfe1.example.org/remoteEntry.json",
  "team/mfe2": {
    "url": "https://mfe2.example.org/remoteEntry.json",
    "integrity": "sha384-…"
  }
}
```

#### Manifest URL integrity

When the orchestrator fetches the manifest itself from a URL, pass `manifestIntegrity` to verify it:

```javascript
import { initFederation } from '@softarc/native-federation-orchestrator';

initFederation('http://example.org/manifest.json', {
  manifestIntegrity: 'sha384-…',
});
```

#### Host remote-entry integrity

The host's own `remoteEntry.json` is configured separately and supports the same `integrity` field:

```javascript
initFederation(manifest, {
  hostRemoteEntry: {
    url: './host-remoteEntry.json',
    integrity: 'sha384-…',
  },
});
```

#### Dynamically added remotes

`initRemoteEntry` accepts the same `RemoteRef` shape, so a dynamically added remote can also be pinned:

```javascript
const { initRemoteEntry } = await initFederation(manifest, { /* … */ });

await initRemoteEntry('http://example.org/late-mfe/remoteEntry.json', {
  name: 'team/late-mfe',
  integrity: 'sha384-…',
});
```

### Caveats

- **Opt-in semantics.** Resources without a configured hash are *not* verified. There is no global "strict integrity" switch — if you want every fetch to be pinned, configure a hash on every entry.
- **Supported algorithms.** `sha256-`, `sha384-`, and `sha512-` are accepted, matching the SRI spec. The build-side default (`@softarc/native-federation`) is `sha384-`.
- **Trust root.** Module hashes only protect the page if the `remoteEntry.json` that publishes them is itself trusted. Pin the manifest (or the host's own remoteEntry) at the top so an attacker who tampers with `remoteEntry.json` cannot also rewrite the hashes inside it.
- **JSON bytes, not the parsed value.** The manifest and remote-entry hashes are computed over the exact response bytes. Re-serialising the JSON (whitespace, key order) at the origin will invalidate the hash — pin the file you publish, not a regenerated copy.
