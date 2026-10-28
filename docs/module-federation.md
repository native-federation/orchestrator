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

Each specifier is shared from the copy the import map serves it from, so MF hands out a package's primary and
secondary entrypoints from the same build, never a secondary only a sibling copy of the version ships. The
`strict` scope offers every shared version side by side, each with the entrypoints of the build serving that
package at that tag (see [Entrypoint coverage and tearing](./version-resolver.md#entrypoint-coverage-and-tearing)).
A strict copy loaded at runtime joins its tag's row behind the basis, so `getShared` keeps offering the build the
committed map serves. A load that brings a row the tag lacked can lead it, though: the root at a tag that had only
secondaries, or a row of an external earlier in the record. A `getShared` call on that same page then offers the
loader's build while the committed map still serves the old one; the next page serves both from the loader's build.
A load from an older build can also merge declared packages the strict scope served separately (see
[One build per package](./version-resolver.md#one-build-per-package)): on that page, `getShared` can offer such a
specifier from another build or drop it, while the committed map keeps serving it from its own.
A remote the import map runs from its own build instead has no place in `ShareInfos`, which offers one location
per specifier and version.
