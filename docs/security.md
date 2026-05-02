[< back](./../README.md)

# Security & Trusted Types

The orchestrator is compatible with the browser [Trusted Types](https://www.w3.org/TR/trusted-types/) API. When the host application enables Trusted Types via Content Security Policy, the orchestrator's two DOM sinks — the `<script type="importmap">` it injects and the dynamic `import()` it uses to load remote modules — flow through a vetted policy instead of writing raw strings.

This page covers what the orchestrator does, the recommended CSP, and how to integrate with a host that already manages its own policies.

## What the orchestrator protects

The library has two places where externally-fetched data reaches a script-execution sink:

| Sink                                          | Source of the data                            | Trusted type      |
| --------------------------------------------- | --------------------------------------------- | ----------------- |
| `<script type="importmap">` content (`replaceInDOM`) | Resolved import map built from `remoteEntry.json` files | `TrustedScript`   |
| Dynamic `import(url)` (`loadModuleFn`)        | Module URLs declared by remotes               | `TrustedScriptURL` |

Both go through a single Trusted Types policy named `nfo` by default. The policy applies two checks:

- **`createScript`** — re-parses the input and verifies it is a valid import map (a plain object with only `imports`, `scopes`, or `integrity` keys). Rejects anything else with a `TypeError`.
- **`createScriptURL`** — verifies the input parses as a URL with an `http:` or `https:` protocol. Rejects `javascript:`, `data:`, and malformed URLs.

On browsers without Trusted Types (and in test environments such as jsdom) the wrapper is a transparent pass-through, so the library behaves identically to a non-Trusted-Types build.

## Recommended CSP

For a host that wants Trusted Types enforced and uses the orchestrator's defaults:

```
Content-Security-Policy: require-trusted-types-for 'script'; trusted-types nfo
```

If the host registers its own policies in addition to `nfo`, list them all (and add `'allow-duplicates'` if a name is registered more than once):

```
Content-Security-Policy: require-trusted-types-for 'script'; trusted-types nfo my-host-policy 'allow-duplicates'
```

### Phased rollout

Trusted Types is best deployed in stages. Start in report-only mode to surface every violation without breaking the page:

```
Content-Security-Policy-Report-Only: require-trusted-types-for 'script'; trusted-types nfo; report-uri /csp-reports
```

Once the report stream is empty, switch to the enforcing header above.

## Configuration

The Trusted Types policy is part of the [import-map configuration](./config.md#importMapConfig) and exposes a single option, `trustedTypesPolicyName`.

```javascript
import { initFederation } from '@softarc/native-federation-orchestrator';

initFederation('http://example.org/manifest.json', {
  // default
  trustedTypesPolicyName: 'nfo',
});
```

### Renaming the policy

If your CSP `trusted-types` allowlist uses different names (for example to keep a project-wide naming convention), rename the orchestrator's policy:

```javascript
initFederation('http://example.org/manifest.json', {
  trustedTypesPolicyName: 'my-app-nfo',
});
```

```
Content-Security-Policy: require-trusted-types-for 'script'; trusted-types my-app-nfo
```

### Opting out

Set the option to `false` when the host already wraps the import map and module URLs through its own policy (for example by overriding `setImportMapFn` and `loadModuleFn`):

```javascript
initFederation('http://example.org/manifest.json', {
  trustedTypesPolicyName: false,
  setImportMapFn: myHostsTrustedSetImportMap,
  loadModuleFn: myHostsTrustedImport,
});
```

With `trustedTypesPolicyName: false` the orchestrator will not call `trustedTypes.createPolicy` at all — useful when the CSP allowlist does not include `nfo` or when a `default` policy is already in place site-wide.

## Caveats

- **Default policy.** The orchestrator does not register a `default` policy. If your host uses one, the host's `default` policy is also consulted whenever a raw string reaches a sink — make sure it is compatible with the import-map and remote-URL data the orchestrator produces, or override the relevant functions.
- **Custom `setImportMapFn` / `loadModuleFn`.** The Trusted Types policy is only active inside the orchestrator's *default* implementations. When you supply your own functions you are responsible for producing trusted values yourself; setting `trustedTypesPolicyName: false` documents that intent.
- **Browser support.** Trusted Types is part of the 2026 Baseline (Chromium 83+, WebKit 26+, Gecko 148+). On older browsers the orchestrator's policy wrapper is a no-op, so existing deployments keep working without modification.
- **Policy ≠ sanitizer.** Trusted Types makes sinks structurally safe by funnelling all writes through a single, auditable choke point. The validators shipped with the orchestrator only check shape (JSON structure, URL protocol) — they are not a substitute for end-to-end controls on which manifests and remote origins your host trusts in the first place.
