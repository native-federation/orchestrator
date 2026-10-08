# Mutation runs for pooling

Measures which tests guard which pooling rule: each mutant breaks one rule, and a test that fails on it kills
it. Used to shrink the suite without losing kill rate (a test that kills nothing unique can go).

## Mutants

Mutants are cut per refactor and kept out of the repo: they are patches against one commit and rot as the code
moves, so a run starts by cutting a set against the commit it measures, in a directory outside the checkout.

One `git diff` patch per mutant, `<dir>/<ID>.diff`. Line 1 is a header, which `git apply` ignores:

```
# <ID> <repo-relative target file>: <the rule it breaks>
# expect: <spec expected to kill it>   (optional)
diff --git a/src/... b/src/...
```

Prod files only, one semantic change, and it must type-check. An ID is a prefix for the area (`MI` election,
`MD` dynamic pooling, `MG` import-map generation, ...) and a number. Make one by editing a clean checkout,
then `{ echo '# MI1 src/...: ...'; git diff; } > ../mutants/MI1.diff && git checkout -- src`. `run.mjs`
reports a mutant that no longer applies.

## Running

Use a dedicated clean checkout, since `run.mjs` applies and reverts patches in it; `--root`, `--mutants` and
`--out` have no defaults:

```
git worktree add --detach ../nf-mut HEAD && ln -s "$PWD/node_modules" ../nf-mut/node_modules
node scripts/mutation/run.mjs --root ../nf-mut --mutants ../mutants --out ../mutation-results [--only MI1,MD2] [--seeds 1,2,3]
node scripts/mutation/analyze.mjs --root ../nf-mut --out ../mutation-results
```

Per mutant it runs the suite (`--suite`, default `src/lib/core,src/lib/testing`) with the CI property seeds,
then the two property files once per `--seeds` entry (`POOLING_PROPERTY_SEED`), side by side. `NONE` is the
unmutated baseline; a test red there is ignored. Reports are cached per mutant; `--force` reruns.

`analyze.mjs` writes `matrix.json` (`byMutant`: CI killers and per-seed property killers; `byTest`: the
mutants each test kills) and prints survivors, unique killers and per-seed kill counts. A mutant only some
seeds kill is seed dependent: the CI seed is the one that guards it.

A property that runs out of time before its cases fails (`markInterruptAsFailure`), which on a loaded machine
says nothing about the mutant: `analyze.mjs` counts it as no kill and lists it, to rerun with `--force` on an
idle machine.
