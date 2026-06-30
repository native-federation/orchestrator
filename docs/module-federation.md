# Module Federation integration (`getShared`)

If an application uses **both** native federation (via this orchestrator) **and**
webpack **Module Federation** (MF), the two systems must share the *same* singleton
instances — one `@angular/core`, one `rxjs`, and so on. Otherwise a webpack remote
loads its own copy of Angular and dependency injection breaks (e.g. `NG0203`).

The `module-federation` entry point converts the orchestrator's globally shared externals
into the `shared` config shape webpack MF expects, so you can hand native federation's
already-resolved singletons straight to MF.

> This is the v4 replacement for `getShared()` from `@softarc/native-federation-runtime@3.x`.
> The v3 helper read its singletons from a flat `externals` map that the orchestrator no
> longer populates — use this entry point instead.

## Usage

```ts
import { initFederation } from '@softarc/native-federation-orchestrator';
import { createGetShared } from '@softarc/native-federation-orchestrator/module-federation';
import { init } from '@module-federation/enhanced/runtime';

// 1. Initialise native federation as usual.
const result = await initFederation({
  'team/mfe1': 'http://localhost:3000/remoteEntry.json',
});

// 2. Build the webpack-MF shared config from the resolved externals.
const getShared = createGetShared(result.adapters);

// 3. Hand the singletons to Module Federation.
init({
  name: 'host',
  remotes: [/* your MF remotes */],
  shared: getShared(),
});
```

`createGetShared` reads the resolved URLs from the generated import map and the
version/range metadata from the orchestrator's `shared-externals` storage, so it never
re-derives the resolver's scope/skip/override decisions.

## Options

```ts
getShared({
  // Mark the externals as MF singletons. Default: true.
  singleton: true,

  // When set, requiredVersion is built as `prefix + version` (the v3 behaviour),
  // e.g. '^' -> '^20.0.0'. When omitted, the range negotiated by native
  // federation is used, falling back to a caret range.
  requiredVersionPrefix: '^',
});
```

## What is included

Only **globally shared** externals (those native federation resolved with
`action: 'share'`) are emitted — these are the singletons MF needs. Packages that
native federation deliberately *scoped* or *skipped* are not shared, and externals
bound to a custom `shareScope` are out of scope for this bridge.
