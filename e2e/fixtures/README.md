# Recorded remoteEntry fixtures

Realistic input for the resolver: `remoteEntry.json` files loaded by
[`pooling/capture.e2e.spec.ts`](../pooling/capture.e2e.spec.ts) through the real
fetch → normalize → resolve → import-map path.

Eleven remotes, `mfe1`–`mfe11`, each served from `http://mfe<n>/` and named `team/mfe<n>`. `mfe1`–`mfe7`
are a **production capture, anonymized**; `mfe8`–`mfe11` are **synthetic**, each built to create a
resolution scenario the capture does not contain.

Names carry nothing on purpose — which remote is the cross-major one, which one pins strictly, which one
is the superset build is stated here and in the spec's own comments, never inferred from a filename.

## Anonymization

Only identifying strings were replaced. Every structural field — `version`, `requiredVersion`,
`strictVersion`, `singleton`, `pool`, `shareScope` — is byte-identical to the capture, so the resolver
sees exactly the input it saw in production.

- Remote names became `team/mfe<n>`.
- The one private package family became `@acme/shell/*`. A scoped name was replaced by another scoped
  name on purpose: auto-pooling groups on the npm scope (`/^@([^/]+)\//`), so flattening it would have
  changed pool membership.
- Product-specific `exposes` keys and `outFileName`s became positional placeholders — `./comp-a`,
  `comp-a.js`, `./comp-b`, … in every remote. Nothing reads an exposed key or file name (the harness
  loads `exposes[0].key`, and no `integrity` or `chunks` entry points at an exposed bundle), so the
  original names and their content hashes carried no signal worth keeping.

`@internal/events` and `@nf-internal/chunk-*` were already generic and are unchanged.

## The captured seven

| file   | shape                                                                                                                        | why it matters                                                                                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mfe1` | Angular **21.2.18**, **flat externals** (older sparse `outFileName` format) and **flat chunking**, 37 shared externals        | the cross-major outlier, and sole provider of `animations`, `compiler`, `platform-browser-dynamic`, `forms/signals` — the members that used to stay shared a major behind everything else |
| `mfe2` | Angular 22.0.8, **flat externals with dense chunking**, `@angular/cdk/*` exact-pinned at `22.0.6`, no `pool` tags, private `@acme/shell/*` + `@internal/events` | mixes two builds inside one family; joins a pool only through auto-scoping                                                                                                |
| `mfe3` | `pool: ng-core`, core 22.0.8 + material 22.0.6, `~22.0.3`                                                                    | the common shape                                                                                                                                                                         |
| `mfe4` | identical to `mfe3`                                                                                                          | two remotes on the same build — election tiebreaks                                                                                                                                       |
| `mfe5` | tight ranges (`~22.0.8` core, `~22.0.6` material), `router` **untagged** while its siblings are tagged                       | the strictest consumer, and partial tagging inside one family                                                                                                                            |
| `mfe6` | Angular **22.0.7** — a tag nobody else ships                                                                                 | a lone patch-level build                                                                                                                                                                 |
| `mfe7` | Angular 22.0.8, minimal 7-member set                                                                                         | a clean subset consumer                                                                                                                                                                  |

`mfe3`–`mfe11` are all **dense externals with dense chunking**, which is what the current builder emits;
the two flat shapes survive only in `mfe1` and `mfe2`. The four shapes as a matrix — and the
`convertFlatSharedInfo` flag that decides how a flat entry is grouped — are covered by
[`pooling/vendor-shapes.e2e.spec.ts`](../pooling/vendor-shapes.e2e.spec.ts) over generated portfolios and
the entries in [`pooling/`](pooling/).

## The synthetic four

| file    | scenario it creates                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mfe8`  | **Same-minor patch drift.** Angular **21.2.15** against `mfe1`'s 21.2.18, both `~21.2.0`, so they accept each other. Gives that remote's sole-provided members a second provider, and stresses the download objective: two legacy copies on two distinct tags against a modern majority agreeing on one.                                                                 |
| `mfe9`  | A strict `~22.0.5` pin, shipping **no `@angular/router`** — the topology that lets `core` resolve down while `router` elects freely elsewhere. Note the pin does *not* reject the 22.0.6/22.0.8 majority (`~22.0.5` allows any `22.0.x >= 22.0.5`), so against this portfolio it simply dedups; reproducing the split needs a **minor** gap, which the generated specs cover. |
| `mfe10` | Three things no captured remote has: a **cross-scope pool bridge** (`@acme/design-system*` tagged `pool: ng-core`, joining another npm scope to the Angular family at a different version line — 4.2.0 beside 22.0.x); an **unscoped lockstep family** (`react` + `react-dom` under `pool: react`, which auto-scoping can never group); and a deliberately **over-loose `^22.0.0`** on the Angular members it consumes. `@acme/design-system/icons` sits in a non-global `shareScope: team-a`, so the per-scope walk is exercised. |
| `mfe11` | The **consistent-but-older superset build**: the widest Angular set of any remote (core, common, elements, forms, platform-browser, router, material, cdk/\*) entirely from one 22.0.6 build, loose `^22.0.0`. A family deduping down to one older-but-consistent build must stay shared — it is the only internally consistent Angular-22 build in the set.              |

## `pooling/`

Hand-written entries in shapes the capture does not contain, driven by
[`pooling/vendor-shapes.e2e.spec.ts`](../pooling/vendor-shapes.e2e.spec.ts). See
[`pooling/README.md`](pooling/README.md).
