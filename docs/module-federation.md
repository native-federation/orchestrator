# Module Federation integration (`getShared`)

If an application uses **both** native federation (via this orchestrator) **and**
webpack **Module Federation** (MF), the two systems must share the _same_ singleton
instances — one `@angular/core`, one `rxjs`, and so on. Otherwise a webpack remote
loads its own copy of Angular and dependency injection breaks (e.g. `NG0203`).

The `module-federation` entry point converts the orchestrator's globally shared externals
into the `shared` config shape webpack MF expects, so you can hand native federation's
already-resolved singletons straight to MF.

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
  remotes: [
    /* your MF remotes */
  ],
  shared: getShared(),
});
```

`createGetShared` reads the resolved externals straight from the orchestrator's
`shared-externals` storage and derives each URL from the providing remote's scope — the
same way the import map is generated — so it never re-derives the resolver's
scope/skip/override decisions and needs no persisted import map.

## Options

```ts
getShared({
  // Mark the externals as MF singletons. When omitted, an external is a
  // singleton only when native federation resolved exactly one shared version
  // for it (the strict scope may share several exact versions side by side).
  singleton: true,

  // When set, requiredVersion is built as `prefix + version` (the v3 behaviour),
  // e.g. '^' -> '^20.0.0'. When omitted, the range negotiated by native
  // federation is used, falling back to a caret range.
  requiredVersionPrefix: '^',
});
```

## Share scopes

Every share scope native federation resolved is bridged, and only versions resolved as
`action: 'share'` are emitted (packages that were deliberately _scoped_ or _skipped_ are
not shared):

| Native federation scope       | Module Federation result                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global (`singleton: true`)    | Shared singleton in MF's default scope (no `scope` set).                                                                                                                                                                                                                                                               |
| Custom `shareScope: "team-a"` | Shared singleton with `scope: "team-a"`.                                                                                                                                                                                                                                                                               |
| `shareScope: "strict"`        | Every shared version, emitted with `scope: "strict"`, `singleton: false`, `strictVersion: true`, and `requiredVersion` pinned to the exact version. It is a version → location map: remotes dedupe only on an identical version, never a range. The `singleton` and `requiredVersionPrefix` options do not apply here. |

```ts
getShared();
// {
//   '@angular/core':         [{ version: '20.0.0', get, shareConfig: { singleton: true, requiredVersion: '^20.0.0' } }],
//   '@angular/core/testing': [{ version: '20.0.0', get, shareConfig: { singleton: true, requiredVersion: '^20.0.0' } }],
//   'ui-lib':                [{ version: '3.0.0', scope: 'team-a', get, shareConfig: { singleton: true, requiredVersion: '^3.0.0' } }],
// }
```

## Secondary entrypoints

MF's `shared` config is flat — one key per import specifier, with no nested `entries` shape it can
consume. So each secondary entrypoint of a shared package is emitted as its own top-level `ShareInfos`
key (`@angular/core/testing` above), resolving to its own file/url alongside the primary entrypoint.
See [`entries` in the version resolver](./version-resolver.md).
