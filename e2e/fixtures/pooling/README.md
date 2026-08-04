# Pooled remoteEntry fixtures

Three hand-written entries in the shape none of the recorded eleven has: **flat externals and flat
chunking together, with `pool` tags** — the pre-`entries` output format, where every entrypoint is its own
`shared` element and every chunk is an `@nf-internal/chunk-*` pseudo-external, from a build whose monorepo
packages declare a pool. `../mfe1` is flat but untagged; every tagged fixture is dense.

Loaded by [`pooling/vendor-shapes.e2e.spec.ts`](../../pooling/vendor-shapes.e2e.spec.ts) through
`poolFixture(n)`, and served from `http://mfe<n>/` like every other fixture.

| file   | declares                                                                                                              | its role                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `mfe1` | `@acme/platform` + `/forms` + `@acme/widgets` at **4.3.2**, `~4.3.0`, all tagged `pool: acme-platform`; `rxjs` 7.8.2 untagged; 2 chunks | the widest build of the family, and the one that ends up serving it                       |
| `mfe2` | the same 4.3.2 build minus `@acme/widgets`, loose `^4.0.0`, same tag; `rxjs`; 1 chunk                                  | the subset consumer — dedups the whole family                                                     |
| `mfe3` | the same three members at **4.2.9** with a strict `~4.2.0`; `rxjs`; 1 chunk                                            | a minor behind and incompatible, so the tag islands it whole — while `rxjs`, in no pool, still dedups |

The tag is what forms the family here, so the spec runs these with `useAutoExternalPooling` **off**: the
`@acme` npm scope would otherwise group the three members on its own and the fixtures would say nothing
about tags. See `pooling/membership.e2e.spec.ts` for the tag mechanism itself.
