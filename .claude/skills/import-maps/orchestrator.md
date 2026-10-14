# How nf-orchestrator builds and reasons about its import maps

This file assumes the browser rules in [SKILL.md](SKILL.md): a file resolves through the scope of its own URL, a
module instance is one URL, and a later map cannot repoint a key.

Paths below are relative to `src/lib/core/`. If a section disagrees with the code, the code wins; fix the section.

## Contents
- Vocabulary
- Two paths: init and dynamic load
- What the init map contains, in write order
- The global share scope
- One serving build per package
- The host never borrows (host gap)
- Pooling: families, subpools, islands
- Named share scopes and the `strict` scope
- The dynamic path
- Module Federation (`getShared`)
- Hazards to check when changing map code
- Verifying a map

## Vocabulary

| term | meaning |
| --- | --- |
| host | The page's own app. Its files are loaded first and can never be repointed. |
| remote | A micro-frontend described by a `remoteEntry.json`; its **scope URL** is that file's directory with a trailing `/` (`http://mfe1/`). Every file it ships lives under that prefix. |
| external | A shared package a remote declares. `singleton: false` externals are private to the remote; the rest are shared within a **share scope** (the global one, a named `shareScope`, or `strict`). |
| entrypoint | A specifier of a package: the root (`@fw/core`) or a secondary (`@fw/core/testing`). The package of a specifier is its npm name (`@scope/name` or `name`). |
| dense / flat | Two ways to declare secondaries. Dense: one external `@fw/core` whose `entries` list `@fw/core` and `@fw/core/testing`. Flat: `@fw/core/testing` is its own external. Both describe one package. |
| build | What one remote ships of a package (or of a pool), as specifier → tag. Same tag does not mean same files. |
| chunk | A build-internal file shared by several entrypoints, keyed `@nf-internal/<chunk-name>`. A **chunked** copy imports its build's chunks, so its files only work beside that build's other files of the package. |
| record | What init stores (per share scope, per external: rows) and rebuilds the map from. |
| row / copy | A row is one `(tag, action)` of an external; its copies are the remotes that take it. The first copy is the row's basis. |
| action | `share`: this row's files are published for the scope. `skip`: these copies use another row's files. `scope`: these copies run their own files, mapped only in their own remote's scope. |
| serving build | The one build that serves a package in a share scope, stored on each of the package's externals. |
| cached | A copy whose file the committed map serves; rankings price it as free. |
| pool | Externals tied together by `pool` labels in `remoteEntry.json`; elected as one family. A secondary always joins its package. |
| subpool | Remotes off the global map that run one other remote's build through their scopes (`servedBy`). |
| self-served / island | A remote that runs its own build for its whole family (`poolCause`: `uncovered` or `incompatible`). |

## Two paths: init and dynamic load

- **Init** reads every manifest remote, stores it, pools, picks versions, picks serving builds, generates the map
  from the stored record and commits. Commit removes every `<script type="importmap">` (or `importmap-shim`) from
  `document.head` (maps elsewhere stay), appends the new map there, then writes storage. Removing an element does not unregister its rules, so this only
  behaves as a replacement when no map was registered before. Because the map is generated from the record, a reload
  with a warm cache should produce the same map as a cold start.
- **Dynamic load** (`initRemoteEntry`) decides each package of the newly loaded remote as a whole against the
  committed record and emits a **delta** map that is *appended*. It never rebuilds or edits the committed map,
  because the page cannot repoint a key it already has. Use it with es-module-shims: it adds a map after modules
  have run, which browsers without multiple-map support ignore.

Code: `2.app/flows/init.flow.ts`, `2.app/flows/init-remote-entry.flow.ts`; commit in `2.app/steps/commit-changes.ts`
and `4.config/import-map/replace-in-dom.ts` (`use-default.ts` / `use-import-shim.ts` pick the map type).

## What the init map contains, in write order

Code: `2.app/steps/generate-import-map.ts`. Later writes into the same scope overwrite earlier ones:

1. `singleton: false` externals → `scopes[remoteScopeUrl][specifier] = remoteScopeUrl + file`.
2. Named share scopes (`strict` included) → consumer scopes. These overwrite a remote's own private mapping of
   the same specifier.
3. The global share scope → `imports`, plus scope entries for subpools and `scope` rows.
4. Exposed modules → `imports['<remoteName>/<exposeKey>']`, unnormalised (`team/mfe1/./App` is a real key).
   `loadRemoteModule` imports the absolute URL instead, so the key only matters to code importing by bare name.
5. Chunks → `scopes[ownerScopeUrl]['@nf-internal/<chunk>']`, never `imports`. Chunk names are build-local, so
   two builds may both have `chunk-ABCD`; they never collide because each lives in its owner's scope and a file
   always resolves through the scope of the URL it was served from.

A bundle's chunks are registered only when one of its copies is actually mapped (the serving build's copy, a
`scope` row, or a subpool's build); a plain `skip` copy registers none. Integrity is keyed by the final URL and
taken from the remote that owns the file.

## The global share scope

Each package's serving build publishes every specifier it ships into `imports`; no other build publishes a
specifier of that package there. A share row of the package at another tag is a duplicate: it publishes nothing
and warns `Singleton external X has multiple shared versions.` (throws `Could not create ImportMap.` under
`strict.strictImportMap`). Ties in choosing the serving build are broken by remote name (code-unit order), so the
map does not depend on registration order. Code: `2.app/steps/determine-shared-externals.ts`.

## One serving build per package

Rule: per remote, every specifier of a package resolves to files of **one** build. A build that lacks an
entrypoint never borrows it from another build, even at the same tag. Swapping a whole package to another build
is allowed; swapping only some of its entrypoints is a stitch.

Ranking of unpooled candidates (copies in the root's `share` rows, else every share row of the package):
host; fewest downloads (one per remote that would run its own build, cached copies cost 0); fewer fallbacks; is
the basis of a root share row; remote name.

**Fallback**: a remote that ships any entrypoint the serving build lacks runs the **whole package** from its own
build: all its copies of every external of the package move to `scope` rows at its own tag.

```
remotes a, b, c at http://a/, http://b/, http://c/, all @fw/core 1.0.0
a ships @fw/core, @fw/core/other;  b ships @fw/core, @fw/core/testing;  c ships @fw/core
serving build: a
imports: { "@fw/core": "http://a/fw_core.js", "@fw/core/other": "http://a/fw_core_other.js" }
scopes:  { "http://b/": { "@fw/core": "http://b/fw_core.js", "@fw/core/testing": "http://b/fw_core_testing.js" } }
```

b downloads core twice instead of running a's core beside its own `testing` (a stitch). c runs a's files.

Other share rows of the package follow the serving tag: their copies become `skip`; a strict copy whose range
rejects the tag becomes `scope` (or init throws under `strict.strictExternalCompatibility`).

## The host never borrows (host gap)

The host's files live at the host URL. If the host's own build lacks an entrypoint its files import, there is no
scope to send it to, so the host is never fixed by borrowing and never replaced. Two shapes, both from broken host
builds (host at `http://host/`, remote `r` at `http://r/`, all at one tag; the host ships only
`@fw/core/interop`, whose file imports `@fw/core`):

- Pooled, `r` ships `@fw/core` and `@fw/core/interop`: `@fw/core` stays unmapped for the host →
  `http://host/fw_core_interop.js` fails with an unresolved `@fw/core`. A loud failure is preferred to a silent
  stitch.
- Unpooled, `r` ships `@fw/core`: `imports["@fw/core"]` is `r`'s file and the host keeps its own interop → the host
  runs core from two builds. The map cannot avoid it; only a host build that ships the root fixes it.

Init logs nothing for a host gap: it cannot see what files import, so a warning would fire on every ordinary
coverage miss. Build-time causes and detection: [shared-dependencies.md](shared-dependencies.md#the-host-gap).

## Pooling: families, subpools, islands

Code: `2.app/steps/pooling/pool-shared-externals.ts` (init) and `pool-dynamic-externals.ts` (dynamic), over
`1.domain/pooling/` (`election.ts`, `gate.ts`, `plan.ts`, `records.ts`).

Pooling elects labelled externals **as one family**: every remote takes the whole family from one build that
shipped it together (the elected one, another remote's, or its own). How rows land in the map:

- `share`: the global map (`imports`, or consumer scopes in a named share scope).
- `skip`: resolves globally; with `servedBy: X` it runs subpool build X through scope entries pointing at X's files.
- `scope` with `poolCause`: the remote serves its own whole family.

**A subpool's build maps its own family onto itself.** A consumer's scope governs only the consumer's own
imports; X's files resolve their peers through X's scope and then `imports`. Without self-entries X's `router`
would bind the global `core` one hop in.

```
host (http://host/): @fw/core, @fw/common 17.0.0
r2 (http://r2/): @fw/core, @fw/common 18.0.0, range ~18 strict
r3 (http://r3/): @fw/core 18.0.0, range ~18 strict  → subpool on r2's build
imports: { "@fw/core": "http://host/fw_core.js", "@fw/common": "http://host/fw_common.js" }
scopes:  { "http://r2/": { "@fw/core": "http://r2/fw_core.js", "@fw/common": "http://r2/fw_common.js" },
           "http://r3/": { "@fw/core": "http://r2/fw_core.js" } }
```

A group (subpool or self-served remote) takes global files only where *every* copy its remotes ship takes them;
otherwise its whole family runs its own build, because a global file's imports bind global peers (see
[shared-dependencies.md](shared-dependencies.md#the-fallback-unit-is-the-family)). Init has no import graph, so the
family is whatever the `pool` labels declare; an unlabelled package falls back alone.

The host's build is elected first whenever it ships a pool member, since its files are already loaded. Each election
candidate is judged only on the entrypoints its own build ships; no build borrows another's.

## Named share scopes and the `strict` scope

- A named share scope has no `imports` of its own: every consumer gets
  `scopes[consumerScopeUrl][specifier] = providerScopeUrl + file`. Sharing is many scopes pointing at one URL.

  ```
  mfe1 ui 3.1.0 and mfe2 ui 3.0.5 (^3.0.5) in shareScope team-a; mfe3 ui 2.5.0 in team-b
  scopes: { "http://mfe1/": { "ui": "http://mfe1/ui.js" },
            "http://mfe2/": { "ui": "http://mfe1/ui.js" },
            "http://mfe3/": { "ui": "http://mfe3/ui.js" } }
  ```
- A `skip` row redirects to the scope's first `share` row; with none it serves the copy's own build (throws under
  `strict.strictImportMap`). As in the global scope, a consumer the serving build does not cover runs the whole
  package from its own build.
- `strict` is a named scope whose rows start as `share` with exact ranges. It has no serving build: each tag is
  shared on its own row, side by side, from that row's basis copy.

## The dynamic path

Code: `2.app/steps/update-cache.ts` decides the rows, `2.app/steps/convert-to-import-map.ts` emits the delta.

Per package of the loaded remote (a dense root and its flat secondaries together), per share scope, against what
the committed map serves of it:

| situation | action | delta map |
| --- | --- | --- |
| the map serves none of it | `share`; the remote becomes its serving build | global: `imports[spec] = own file`; named: own scope |
| one build serves every entrypoint the remote ships of it, at a tag no `strictVersion` range of the remote rejects | `skip`, in a `skip` row of its tag | nothing new in `imports`; named: scope entries to every file that build serves of the package |
| the map lacks an entrypoint the remote ships, or serves the package from two builds | `scope` | the whole package from its own files, in its own scope |
| a `strictVersion` range rejects the map's tag | `scope` + warning (throws under `strictExternalCompatibility`) | as above |
| `singleton: false` | — | own scope |

A range without `strictVersion` follows the map's tag without a warning. A remote that scopes a package because
the map serves it only in part opens no other package globally: an opened package's files resolve through the
loader's scope, so their consumers would reach the loader's build too. The `strict` scope shares every version side
by side. So a load never maps a key the committed map already has.

Pools on the dynamic path pass a gate: the remote resolves globally only if no range rejects a tag the map serves,
every committed file it would reach resolves each specifier to the file it would itself use, no chunked copy would
run part of a package beside the map's files of it, and the map serves each package wholly or not at all for it.
Otherwise it serves its whole family in its own scope. The dynamic path holds no election and never repoints a
committed build; the next init re-elects. A cold init may therefore pick other builds than a page that loaded
remotes one by one.

```
committed: imports { "react": "http://mfe1/react.js" }   (react 18.2.0)
load mfe3 (react 17.0.2, ~17.0.0 strict):
  delta: { "imports": { "mfe3/./App": "http://mfe3/App.js" },
           "scopes":  { "http://mfe3/": { "react": "http://mfe3/react.js" } } }
```

## Module Federation (`getShared`)

Code: `src/lib/module-federation/get-shared.ts`.

`getShared` hands Module Federation the files the import map serves: per specifier, the copy that claims it, so a
package's root and secondaries come from one build. The `strict` scope offers every shared version, each from its
basis copy. A change to what the map publishes must keep `getShared` in step, or a Module Federation consumer loads
a second instance of a package the page already runs.

## Hazards to check when changing map code

The general ones (mixed builds, chunks, partial scopes, scope leaks, family fallback) are in
[shared-dependencies.md](shared-dependencies.md). Specific to this code:

- **A delta must never restate a committed `imports` key.** The browser keeps the first mapping, natively and in
  es-module-shims without `mapOverrides`, so the remote would silently run the page's file and the record would
  claim otherwise. The dynamic path decides per *package*, not per external name, precisely so a specifier another
  external published (flat vs dense) is seen. A late remote needing a different file for a mapped specifier gets it
  through its own scope. Keep the e2e spec that loads with `mapOverrides` off passing.
- **Init cannot see what files import.** It only knows what `remoteEntry.json` declares, so scope leaks through
  served files cannot be fully ruled out, and the fallback family is whatever `pool` labels declare. Swapping the
  serving build swaps the scope that comes with it. On the dynamic path, an unpooled remote that runs one package
  itself but takes another package's file from a committed build can load the first package twice through that
  file; a `pool` label covering both packages prevents it.
- **Order dependence.** Anything decided by row order rather than by name can change with manifest order or with
  a redeploy. Test both registration orders.
- **Record vs page drift.** A loaded module cannot be unloaded: overriding an already-loaded remote changes the
  record but not the page, and a failed dynamic load can leave stored copies no map ever published.
- **Warm vs cold.** A warm init only fetches manifest remotes; stored state (removed remotes, a stale `cached`
  flag) can make a reload's map differ from a cold start. Compare both.
- **CSP.** `replace-in-dom.ts` routes the map through a Trusted Types policy but sets no `nonce`. Under a
  nonce-based `script-src` without `'strict-dynamic'` (or `'unsafe-inline'`) the map is blocked silently and every
  bare import fails; with `'strict-dynamic'` it is allowed because a trusted script inserted it.
- **Nested scope URLs.** A remote at `http://host/mfe1/` under a host scoped at `http://host/` falls through to
  the host's scope before `imports`. Nothing guards against it.

## Verifying a map

Use the page walk from [shared-dependencies.md](shared-dependencies.md#judging-a-map) on the generated map, in both
registration orders, warm and cold. For browser tests, mind the `mapOverrides` caveat in
[runtimes.md](runtimes.md#where-es-module-shims-differs-from-native).
