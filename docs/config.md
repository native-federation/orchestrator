[< back](./../README.md)

# native-federation configuration

The `@softarc/native-federation-orchestrator` library supports a multitude of different configuration settings. The configuration objects are intended to provide more fine-grained control over the behavior of the `@softarc/native-federation-orchestrator` library.

The configuration is divided into 5 sections

1. [Host related configuration](#hostConfig)
2. [ImportMap implementations and polyfilling](#importMapConfig)
3. [Logging](#loggingConfig)
4. [Modes (strictness and external resolving settings)](#modeConfig)
5. [Storage](#storageConfig)

## <a id="hostConfig"></a> 1. Host configuration

The `hostRemoteEntry` configuration is meant for adding a host remoteEntry file which receives priority during the determine-shared-versions step. That is, when an external version is defined in the host remoteEntry.json file, it will be guaranteed the shared version. The goal of the cachetag is to avoid caching the remoteEntry.json file.

```javascript
export type HostOptions = {
    hostRemoteEntry?: string | false | {
        name?: string,
        url: string,
        cacheTag?: string,
        integrity?: string
    },
    manifestIntegrity?: string
}
```

### Options:

| Option            | Default     | Description                                                                                                                                                                                          |
| ----------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hostRemoteEntry   | `false`     | Allows for the inclusion of a host remoteEntry.json file. The optional `integrity` field pins the host's remoteEntry.json against an SRI hash (see [Security](./security.md#subresource-integrity)). |
| manifestIntegrity | `undefined` | SRI hash for the manifest URL passed as the first argument to `initFederation`. When set, the orchestrator verifies the manifest bytes before parsing.                                               |

### Example

```javascript
import { initFederation } from '@softarc/native-federation-orchestrator';

initFederation('http://example.org/manifest.json', {
  hostRemoteEntry: { url: './remoteEntry.json' },
});
```

### Pinning resources with integrity

Manifest entries, the manifest URL itself, and the host remoteEntry can each carry an SRI hash. Verification is opt-in per resource — entries without a hash are fetched unverified, matching the semantics of `<script integrity="…">`.

```javascript
initFederation('http://example.org/manifest.json', {
  manifestIntegrity: 'sha384-…',
  hostRemoteEntry: {
    url: './host-remoteEntry.json',
    integrity: 'sha384-…',
  },
});
```

Per-remote pinning lives in the manifest itself — entries can be either the existing string form or a `{ url, integrity }` object:

```json
{
  "team/mfe1": "https://mfe1.example.org/remoteEntry.json",
  "team/mfe2": {
    "url": "https://mfe2.example.org/remoteEntry.json",
    "integrity": "sha384-…"
  }
}
```

> See [Security & Subresource Integrity](./security.md#subresource-integrity) for the full trust chain (manifest → remoteEntry.json → modules) and the supported hash algorithms.

## <a id="importMapConfig"></a> 2. ImportMap configuration

The native-federation library uses importmaps under the hood for module resolving. Since importmaps are a [relatively new feature of browsers](https://caniuse.com/import-maps), it might be a good idea to use a polyfill that is guaranteed to work, also in older browsers. There are 2 options supported: default and [es-module-shims](https://www.npmjs.com/package/es-module-shims/v/1.0.1).

```javascript
export type ImportMapOptions = {
    loadModuleFn?: (url: string) => Promise<unknown>
    setImportMapFn?: (importMap: ImportMap, opts?: { override?: boolean }) => Promise<ImportMap>
    reloadBrowserFn?: () => void
    trustedTypesPolicyName?: string | false
}
```

### Options:

| Option                 | Default                             | Description                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| setImportMapFn         | `replaceInDOM("importmap")`         | The function that adds the importmap to the host, by default this is the DOM.                                                                                                                                                                 |
| loadModuleFn           | `url => import(url)`                | This function can mock or alter the 'import' function, necessary for libraries that shim the import function.                                                                                                                                 |
| reloadBrowserFn        | `() => {window.location.reload();}` | This function can mock or alter the "reload browser" behavior that is triggered when SSE is enabled and an user rebuilds a remote.                                                                                                            |
| trustedTypesPolicyName | `"nfo"`                             | Name of the [Trusted Types](./security.md) policy that wraps import-map content and dynamic-import URLs in the default `setImportMapFn` and `loadModuleFn`. Pass `false` to opt out. No effect on browsers that do not support Trusted Types. |

### Example

```javascript
import 'es-module-shims';
import { initFederation } from '@softarc/native-federation-orchestrator';
import { useShimImportMap, useDefaultImportMap, replaceInDOM } from '@softarc/native-federation-orchestrator/options';

initFederation('http://example.org/manifest.json', {
  // Option 1: Using es-module-shims
  ...useShimImportMap({ shimMode: true }),

  // Option 2: Using the default importmap
  ...useDefaultImportMap(),

  // Option 3: Custom properties
  loadModuleFn: (url: string) => { return customImport(url); },
  setImportMapFn: replaceInDOM('<importmap-type>'),

  // Option 4: rename the Trusted Types policy to match a stricter CSP allowlist
  trustedTypesPolicyName: 'my-app-nfo',
});
```

> See [Security — Trusted Types](./security.md#trusted-types) for the recommended CSP header and how the orchestrator interacts with a host-defined policy.

## <a id="loggingConfig"></a> 3. Logging configuration

Allows for the configuration and specificity of logging. Additionally, a custom logger can be defined.

```javascript
export type LoggingOptions = {
    logger?: Logger,
    logLevel?: "debug"|"warn"|"error",
    sse?: boolean
}
```

### Options:

| Option   | Default      | Description                                                                                                                                                                                              |
| -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| logger   | `noopLogger` | The logger is an object that returns a callback per logging type. This way, a custom log implementation can be provided next to the 2 integrated loggers `noopLogger` and `consoleLogger`.               |
| logLevel | `"error"`    | There are currently three loglevels, every loglevel will allow the logging of the specified level including all levels with a higher priority, e.g. `warn` will allow the logging of `warn` and `error`. |
| sse      | `false`      | The SSE is a debug feature that listens for rebuilds of the remotes, and reloads the page if a rebuild occurs.                                                                                           |

### Example

```javascript
import { initFederation } from '@softarc/native-federation-orchestrator';
import { noopLogger, consoleLogger } from '@softarc/native-federation-orchestrator/options';

initFederation('http://example.org/manifest.json', {
  logLevel: 'debug',

  // Option 1: noopLogger
  logger: noopLogger,

  // Option 2: consoleLogger
  logger: consoleLogger,
});
```

## <a id="modeConfig"></a> 4. ModeConfig

The mode config focusses on the way the library behaves, especially when resolving shared externals. The options are meant as hyperparameters to tweak the strictness of native-federation.

```javascript
export type ModeOptions = {
  strict?: boolean | {
    strictRemoteEntry?: boolean;
    strictExternalCompatibility?: boolean;
    strictExternalSameVersionCompatibility?: boolean;
    strictExternalVersion?: boolean;
    strictImportMap?: boolean;
  };
  profile?: {
    latestSharedExternal?: boolean;
    skipInvalidExternalVersions?: boolean;
    overrideCachedRemotes?: 'always' | 'never' | 'init-only';
    overrideCachedRemotesIfURLMatches?: boolean;
    cacheTag?: string;
    mergeManifests?: boolean;
  };
  feature?: {
    convertFlatSharedInfo?: boolean;
  };
};
```

### Options:

The strictness part will define how the orchestrator behaves when an unexpected or erronous situation occurs. The profile focusses on how aggressive the orchestrator should handle caching.

#### Strictness

| Option                                        | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| strict                                        | `false` | When true, the init function will throw an error if anything goes wrong during initialization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| strict.strictRemoteEntry                      | `false` | Will throw an error if anything is wrong with a fetched remoteEntry.json. When false, the remote will be skipped if something goes wrong.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| strict.strictExternalCompatibility            | `false` | Will throw an error if any of the shared externals are incompatible with other shared external versions. If the value is false, the external will be set to "scoped" instead of "shared".                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| strict.strictExternalSameVersionCompatibility | `false` | This is an extreme niche edge case. Will throw an error if the external's shared version (e.g. rxjs version 1.2.3) was already processed and cached, but the to-be-processed versionRange is different than the cached versionRange. This hypothetically could cause an issue when the "chosen" version was removed and this fallback was chosen as the new shared version since it supports a different version range according to the metadata                                                                                                                                                                                                  |
| strict.strictExternalVersion                  | `false` | Will throw an error if the version of an external is not valid semver or missing. When false, the external is instead coerced to the smallest version that matches its requiredVersion range — unless `profile.skipInvalidExternalVersions` is enabled, in which case the external is skipped. Takes precedence over `profile.skipInvalidExternalVersions`.                                                                                                                                                                                                                                                                                       |
| strict.strictImportMap                        | `false` | Will throw an error if anything goes wrong during the buildup of the importMap. (If something is wrong with the cached externals or the cache is corrupt).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

#### Profiles

| Option                                    | Default     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| profile.latestSharedExternal              | `false`     | When enabled, the version resolver will prioritize using the latest version of a shared external over the most optimal version.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| profile.skipInvalidExternalVersions       | `false`     | When enabled, an external whose version is not valid semver or missing is skipped (not added to storage) instead of being coerced to the smallest version of its requiredVersion range. Has no effect when `strict.strictExternalVersion` is set, which throws instead.                                                                                                                                                                                                                                                                                        |
| profile.overrideCachedRemotes             | `init-only` | When enabled, the library will override the cached remotes. The default behavior is to check if the remoteName is in the cache and the remoteEntry url differs from cached remoteEntry url (scopeUrl + "remoteEntry.json) . Available options are `never`, `init-only` and `always`; `always` is deprecated and behaves like `init-only`, since a dynamic init never overrides a cached remote                                                                                                                                                                                                                                                                            |
| profile.overrideCachedRemotesIfURLMatches | `false`     | When enabled, the library will override the cached remote, even if the remoteName already exists in cache and the remoteEntry.json URL matches the cached remoteEntry.json url. Without it, a remote redeployed at the same URL keeps its stored remoteEntry on an init over a cache kept across page loads, even with a `cacheTag`; deploy each build at its own URL, or enable this option. Has no effect when `overrideCachedRemotes` is `never`.                                                                                                           |
| profile.cacheTag                          | `undefined` | When set, the given value is appended as a `?cacheTag=<value>` query param to every remoteEntry.json request, letting you bust HTTP caches across all remotes at once. The host's own `hostRemoteEntry.cacheTag` takes precedence for the host remoteEntry when both are set.                                                                                                                                                                                                                                                                                  |
| profile.mergeManifests                    | `true`      | `true`: every page's manifest adds to what storage keeps, so remotes from other pages (and ones loaded through `initRemoteEntry`) stay available. Set `false` only when every page passes the same complete manifest: an init then drops the stored remotes that manifest doesn't list, so a remote removed from the manifest stops being served on the next page. With per-page manifests, `false` makes each page drop the others' remotes and fetch them again. See [Remotes a manifest no longer lists](./version-resolver.md#remotes-a-manifest-no-longer-lists). |

#### Features

| Option                         | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| feature.convertFlatSharedInfo  | `false` | Opts into runtime densification of remoteEntry shared externals. Core v4.3.0 emits `DenseSharedInfo` (a per-package `entries` map covering primary and secondary entrypoints) natively; those pass through unchanged. For older/flat remote builds that emit one flat `SharedInfo` per entrypoint, enabling this groups secondary entrypoints under their parent package (by npm scope) so they resolve as one shared external.                                                                                                                                                                                                 |

### Example

```javascript
import { initFederation } from '@softarc/native-federation-orchestrator';
import { defaultProfile, cachingProfile } from '@softarc/native-federation-orchestrator/options';

initFederation('http://example.org/manifest.json', {
  strict: true, // All settings to strict: true
  profile: cachingProfile, // { latestSharedExternal: false, skipInvalidExternalVersions: false, overrideCachedRemotes: 'never', overrideCachedRemotesIfURLMatches: false, mergeManifests: true }
});
```

## <a id="storageConfig"></a> 5. StorageConfig

The library stores the current state by default in the globalThis object, it is possible to provide a custom storage or switch to localStorage or sessionStorage.

```javascript
type StorageOptions = {
    storage?: StorageEntryCreator,
    clearStorage?: boolean,
    storageNamespace?: string,
    exposeStorageGetter?: boolean,
}
```

### Options:

| Option              | Default                   | Description                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| storage             | `globalThisStorageEntry`  | Allows the provision of a custom storage implementation. A custom storage must store a copy on `set` and return a fresh copy from `get`, as the built-in storages do.                                                                                                                                                              |
| clearStorage        | `false`                   | When enabled, the initFederation function will clear the current cache/storage before initializing the remoteEntries. The cache is also cleared once, automatically, when it was written by another orchestrator version: the `cache-state` key carries a `version` stamp next to the other keys, and any other stamp, or none, drops every entry. |
| storageNamespace    | `"__NATIVE_FEDERATION__"` | The namespace under which the cache will be stored. e.g. remotes will be stored under `__NATIVE_FEDERATION__.remotes` in localStorage                                                                                                                                                                                              |
| exposeStorageGetter | `true`                    | Publishes a read-only `get(key)` on [`globalThis.__NF_ORCHESTRATOR__`](#discovering-the-storage-from-tools). Set to `false` to keep the state of a custom storage unreadable for page scripts.                                                                                                                                     |

A write the storage rejects, for example because `localStorage` or `sessionStorage` is full, is logged as a warning. That page keeps its cache in memory from then on, and the next page starts without one.

### Example

```javascript
import { initFederation } from '@softarc/native-federation-orchestrator';
import {
  globalThisStorageEntry,
  localStorageEntry,
  sessionStorageEntry,
} from '@softarc/native-federation-orchestrator/options';

initFederation('http://example.org/manifest.json', {
  clearStorage: true,
  storageNamespace: '__custom_namespace__',

  // Option 1: globalThis
  storage: globalThisStorageEntry,

  // Option 2: localStorage
  storage: localStorageEntry,

  // Option 3: sessionStorage
  storage: sessionStorageEntry,
});
```

### Discovering the storage from tools

Every `initFederation` call publishes a frozen, read-only descriptor on `globalThis.__NF_ORCHESTRATOR__`, so devtools, extensions and debug scripts can find the cached state without knowing the host's config:

```javascript
globalThis.__NF_ORCHESTRATOR__ = {
  storage: {
    // keyed by storageNamespace; multiple namespaces on one page are all listed
    __NATIVE_FEDERATION__: {
      version: 'x.y.z', // the orchestrator that published this namespace
      type: 'localStorage', // 'globalThis' | 'localStorage' | 'sessionStorage' | 'custom'
      namespace: '__NATIVE_FEDERATION__',
      keys: ['remotes', 'shared-externals', 'scoped-externals', 'shared-chunks', 'cache-state'],
      get: key => {}, // a copy of the stored value; absent when exposeStorageGetter is false
    },
  },
};
```

There are two ways to read the state:

- **`get(key)`** works for every storage, including custom ones. It returns a copy of the last committed value (in-progress work is only written to storage when a flow commits it), or `undefined` for a key that isn't in `keys`. Nothing on the descriptor can write to the storage. For the built-in storages this exposes nothing new, but a custom storage that keeps its state in a closure becomes readable by any page script; pass `exposeStorageGetter: false` to prevent that.
- **Reading the location directly** is for tools that must not call page functions, such as a passive devtools probe. `type` tells you where each key lives:

| type             | Location of `<key>`                                      |
| ---------------- | -------------------------------------------------------- |
| `globalThis`     | `globalThis[namespace][key]`                             |
| `localStorage`   | `localStorage.getItem(\`${namespace}.${key}\`)` (JSON)   |
| `sessionStorage` | `sessionStorage.getItem(\`${namespace}.${key}\`)` (JSON) |
| `custom`         | Not directly readable; use `get(key)`                    |

`cache-state` holds `{ version, undecidedScopes }`: the orchestrator version that wrote the cache, and the share scopes a runtime load wrote since their serving builds were last decided (see [One build per package](./version-resolver.md#one-build-per-package)). Each namespace carries its own `version`, because separate orchestrator bundles on one page can publish side by side. Publishing never fails `initFederation`: if the global can't be written, the descriptor is simply missing.

A custom `StorageEntryCreator` reports `'custom'` unless you tag it with a `type` property (e.g. `myStorage.type = 'localStorage'` when it wraps localStorage with the same key layout). The published object is typed as `NFOrchestratorGlobal` (exported from `@softarc/native-federation-orchestrator/options`).
