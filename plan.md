# plan.md — pooling family coherence (issue #63)

Loopable execution plan for the fix designed in **`research.md`**. Issue:
[#63](https://github.com/native-federation/orchestrator/issues/63). Branch: `issues/63`.

## Loop protocol

Each pass: read this file, find the **first unchecked** iteration, do **only that one**, run its
verify commands, then tick its box and append a one-line result under it. Stop after one iteration.

- Verification failing ⇒ stay in the same iteration and fix; never tick a box on red.
- Never skip ahead: later iterations assume earlier ones landed.
- Commit per iteration (`fix(63): …` / `refactor(63): …`), no push unless asked.
- `research.md` is the spec. If reality contradicts it, update `research.md` first, then continue.

> **SPEC = `research.md` §15** (family-instance model, simplified 2026-07-29). §4–§5, §7 and §12.3 are
> superseded reasoning trail — **do not implement from them**. All design questions are closed; the
> decisions are listed under "Hard constraints" below.

## Status

- [x] 0 — Branch + baseline
- [x] 1 — Extract `applyWinner` (pure refactor)
- [x] 2 — Family-instance primitives (pure, unit-tested)
- [ ] 3 — No-op-pool early-out (W1) + log levels
- [ ] 4 — Election: host-pinned, remotes-served objective
- [ ] 5 — Per-remote all-skip-or-all-scope + fixed point
- [ ] 6 — Dynamic-init mirror (additive only)
- [ ] 7 — Warm-init dirty-gated skip (W2 — 45% of warm init)
- [ ] 8 — Regression + fixture specs
- [ ] 9 — Docs
- [ ] 10 — Final gates + PR

## Hard constraints (re-read every pass)

**The model** (`research.md` §13, §15.1). Unit of decision = a **family instance**: one remote's whole
build, i.e. its full set of `(member → tag)`, internally consistent *by construction*. Tolerance is the
remote's declared **`requiredVersion`** — never a tag granularity, and there is **no tag-distance concept
anywhere** in the implementation.

1. **Host wins, always** — priority #1, above pooling. Host tags are pinned *before* election and never
   re-pointed by election or extension.
2. **Membership** unchanged: `pool` tag / npm scope → connected components (`pool-graph.ts`).
3. **Election objective**: maximise **remotes that can dedup entirely onto the instance**. This is the only
   scoring term — never raw instance size, which elects the Angular-21 instance on the real capture and
   islands 3 remotes (46 downloads vs 17). Tiebreaks, in order: fewer chosen instances → instance size →
   host → declaring remote → name.
4. **Single-provider members are assigned directly**, never scored (mandatory: it is the difference between
   4.4 ms and 262 ms at R=50/M=80).
5. **Acceptance = `requiredVersion` only.** One test — `isCompatible(tag, requiredVersion) ||
   !strictVersion` (§15.1 rule 4, qualified 2026-07-30). A loose remote accepts anything, because
   `applyWinner` already only scopes a rejecting version when some remote objected **strictly**;
   testing the range alone would make pooling stricter than the resolver it defers to. Binds in
   iteration 5 (`canTakeAllFrom`) and iteration 6 (dynamic).
6. **All-skip or all-scope** per remote: a remote that cannot take every member it consumes from the chosen
   instances scopes its **whole** family from its own build. No partial mixing.
7. **`determine`'s verdicts are unchanged** (§15.3): the strict-incompatibility gate (`islandedRemotes`,
   `action === 'scope'`) stays **outermost and first**, and candidate instances are restricted to
   `share`/`skip` versions — a `scope` version is never promoted.
8. **The per-remote pass iterates to a fixed point** (§15.4), re-entered only after a round that scoped
   someone.
9. **Logging** (§15.1 rule 6): a remote drawing from >1 instance logs at **`debug`** — it is the normal case
   and not actionable. **`warn`** is reserved for islanding, once per (pool, remote), naming the member and
   tag that made it impossible. Suppress the derived `warnIfScopedOnly` when an island in the same pass
   caused the member to lose its last provider.
10. **No throw** under `strictExternalCompatibility` for an acceptance-driven all-scope (§11.5); the
    existing defensive throw at `pool-shared-externals.ts:87-93` stays untouched.
11. **Dynamic init is additive only** (§15.5): never re-point a committed version; the loaded remote is the
    only thing that can move.

**Known limitation, by design** (§15.6): Case 2 (host pins a member + a remote with an over-loose `^` range
solely provides a sibling) stays mixed. Accepted trade — host priority outranks pooling. Mitigation is the
authoring rule "declare `~22.0.6`". Its repro arm is **not** inverted.

**Release**: **patch** (§11.7, Auke 2026-07-29). Note in the release notes that pooled families may island
where they previously mixed builds.

**Performance** (§9) — explicit user constraint, *no unnecessary calculations*:
1. `!useAutoExternalPooling && !hasPoolTag()` stays the first statement in the step.
2. Two precomputations are **mandatory, not optimisations** (§13.4): the **acceptance table**
   (`remote → member → Set<accepted tag>`, built with determine's memoized `isCompatible`) and **direct
   assignment of single-provider members**.
3. Early-out before any scoring when the pool is already single-instance.
4. Reuse determine's memoized `isCompatible`; never replicate its O(versions²) loop.
5. Fixed point re-entered only after an actual island.
6. Allocation discipline (cf. `7bec314`, `3000f6c`): reuse maps, index loops in inner passes.

**Measured baseline** (`research.md` §9.1, capture in the untracked `benchmark/`; probe at
`<scratchpad>/perf-probe.spec.ts.keep`): cold init 2.06 ms total — process 0.82 / determine 0.38 /
pool 0.51 / importMap 0.36. Warm init 0.48 ms total, of which **pooling is 45%** and determine is
0.008 ms. `buildPools` alone 0.086 ms; `isCompatible` during determine 11 calls. Election is *not*
the cost centre — the writes are (W1) and the warm recompute is (W2). Re-measure with the probe after
iterations 3, 4 and 7; a regression in the pooling column is a blocker.

**Expected outcomes** (§13.3/§14.1/§15 — assert these, don't re-derive them): capture 29 → **17** downloads;
Case 1 fixed at 3; Point 4 4 → **2**, 0 islands; R=50 patch+ragged 140 → **80**, 0 islands; R=50 major+ragged
459 → **429**, 16 islanded; M=145 381 → **145**, 0 islands.

## Verify commands

| what | command |
| --- | --- |
| targeted | `npx vitest run --coverage.enabled=false <paths>` |
| pooling suite | `npx vitest run --coverage.enabled=false src/lib/core/2.app/steps/pooling src/lib/core/2.app/steps/determine-shared-externals.spec.ts` |
| full suite (coverage gates: 80% lines/branches/functions) | `npm test` |
| source types | `npx tsc --noEmit -p tsconfig.build.json` — **must be clean** |
| lint / dead code | `npm run lint` · `npm run knip` |

`npx tsc --noEmit -p tsconfig.json` has **pre-existing** spec/mock type drift (e.g.
`convert-to-import-map.integrity.spec.ts:151`) — not caused by this work, do not chase it. Use
`tsconfig.build.json` as the type gate.

---

## 0 — Branch + baseline

**Goal:** clean starting point, known-green baseline.

**Steps**
1. `git checkout issues/63` (exists, 0 commits ahead of `main`).
2. Move the repro spec onto the branch if it isn't there (`split-family.repro.spec.ts`, currently
   untracked); commit it as-is — it documents the broken behaviour. Its **Case 1** arm is inverted in
   iteration 4; its **Case 2** arm stays (§15.6) and only gets a docblock rewrite in iteration 8.
3. Record the baseline: full suite + `tsconfig.build.json` types.

**Verify:** `npm test` green · `npx tsc --noEmit -p tsconfig.build.json` clean.
**Done when:** on `issues/63`, repro spec committed, baseline recorded below.

**Result (2026-07-30):** on `issues/63`, was 0 commits ahead of `main` (`0fb0d3f`). Repro spec +
`plan.md`/`research.md` committed; `benchmark/` left untracked (production capture). Baseline:
**73 test files / 778 tests passed**, coverage 96.05% stmts · 90.61% branches · 95.39% funcs ·
96.63% lines (all above the 80% gates); `tsc -p tsconfig.build.json` clean. Both repro arms green
against `main` behaviour = both bugs live.

---

## 1 — Extract `applyWinner` (pure refactor, no behaviour change)

**Read:** `research.md` §8.

**Files:** `src/lib/core/2.app/steps/determine-shared-externals.ts` (+ its specs).

**Steps**
1. Extract from `setVersionActions` the tail that assigns verdicts for a chosen winner: the
   `versions.forEach(accepts/objector…)` block, `sharedVersion.action = 'share'`, then
   `applyEntrypointCoveragePolicy`, then `dirty = false`.
2. Signature: `applyWinner(externalName, external, winner, isCompatible)` — takes the **memoized**
   `isCompatible` so pooling can pass determine's memo in (§9.4). Keep `accepts`/`objector`/`Tear`
   helpers with it; do not duplicate them.
3. Export it where pooling can reach it without a layer violation (a `1.domain/externals/*` helper or
   a shared `2.app/steps` module — follow whatever the existing import direction allows).
4. `setVersionActions` now = choose winner, then call `applyWinner`. **Zero behaviour change.**

**Why it matters:** election re-points a member's winner *and* its `remotes[0]` serving basis, which is what
`applyEntrypointCoveragePolicy`/`findTears` key off (PR #62). Without this, iteration 4 silently invalidates
that analysis. Do **not** re-run `determine` instead — it would re-elect by its own heuristic and undo the
pool's choice.

**Verify:** `npm test` green with **no spec edits** (this is the proof it's behaviour-preserving) ·
types clean · `npm run lint`.
**Done when:** determine has one election tail, callable from pooling, suite untouched.

**Result (2026-07-30):** new `src/lib/core/2.app/steps/apply-winner.ts` (same layer as pooling, so
`pool-shared-externals.ts` can import it directly — no layer violation, no `1.domain` move needed).
Exports:
- `versionAcceptance(external, isCompatible)` → `{ accepts, objector, demands }`, the demands map built
  once per external. `demands` is exposed because determine's extra-download predicate
  (`!cached && strictVersion && !isCompatible`) is a third question neither `accepts` nor `objector`
  answers — `objector` finds the *first* strict rejector, which may be cached, so it cannot stand in.
- `createApplyWinner(config)` → `applyWinner(externalName, external, winner, isCompatible, acceptance?)`,
  closing over `applyEntrypointCoveragePolicy`/`findTears`/`scopeTornRemotes`/`Tear` (all moved out of
  determine). `acceptance` is optional so pooling can call it with just determine's memoized
  `isCompatible`; determine passes its prebuilt one so no second demands map is allocated.
- `IsCompatible` type alias, now used for determine's memo too.

The single-version short-circuit is preserved *inside* `applyWinner` as `if (versions.length > 1)`
around the verdict loop: with one version the loop would set `skip` then overwrite with `share`, but it
would also strict-check a lone version against its own tag, which today never happens. `determine`'s
`setVersionActions` is now just "choose winner → `applyWinner`"; 134 lines deleted, 14 added.

`npm test` **778/778 green with zero spec edits** (the behaviour-preservation proof) · coverage 96.06/90.54/95.43/96.64
· `tsc -p tsconfig.build.json` clean · `npm run lint` 0 errors (7 pre-existing `no-explicit-any` warnings in
untouched files) · `npm run knip` only the pre-existing `@angular/core` config hint · prettier clean.

---

## 2 — Family-instance primitives (pure functions, unit-tested)

**Read:** `research.md` §13.1–§13.2, §13.4, §15.1.

**Files:** new `src/lib/core/2.app/steps/pooling/family-instance.ts` (+ `.spec.ts`); `pool.types.ts` for
new types.

**Steps**
1. `buildInstances(members): Map<RemoteName, Map<ExternalName, tag>>` — one pass over
   members × versions × remotes. A remote's instance is every member it ships and the tag it ships it at.
   **Count only `share`/`skip` versions** (§15.3 constraint 7).
2. `consumedMembers(members, remote): ExternalName[]` — what the remote actually consumes (what it must be
   served, whether or not it ships it).
3. `buildAcceptanceTable(instances, members, isCompatible): Map<RemoteName, Map<ExternalName, Set<tag>>>` —
   **mandatory precomputation**. For each remote × member, the set of offered tags its declared
   `requiredVersion` accepts. Built once per pool with the injected memoized `isCompatible`; the distinct
   `(tag|range)` question count stays tiny (3–14 measured, even at R=50/M=145) — it is the *call* count that
   explodes without it (510k).
4. `singleProviderMembers(instances, members): Set<ExternalName>` — members exactly one instance ships.
   **Mandatory**: these are assigned directly and never scored (§13.2 step 2).
5. `canTakeAllFrom(acceptance, chosen, remote, consumed): boolean` — the acceptance test behind
   all-skip-or-all-scope: every consumed member's chosen tag is in the remote's accepted set.
6. `hostPinnedTags(members): Map<ExternalName, tag>` — members whose winner is `host`; seeded **before**
   election and never re-pointed (§15.1 rule 1).
7. Unit-test each against the §15 fixture shapes (Cases 1/2/3/5, Point 4). No wiring yet.

**Verify:** `npx vitest run --coverage.enabled=false src/lib/core/2.app/steps/pooling` green · types
clean · `npm run knip` (nothing reported unused — wired in 4/5).
**Done when:** primitives exist, tested, allocation-lean, unused by production code.

**Result (2026-07-30):** new `pooling/family-instance.ts` + `.spec.ts` (18 tests), types in
`pool.types.ts` (`FamilyInstance`, `FamilyInstances`, `AcceptanceTable`, `ChosenTags`). Full suite
**796/796 green** (74 files), types clean, lint 0 errors, knip clean, prettier clean.

Three signature deviations from the wording above, all deliberate:
1. **`buildInstances(members, islanded?)` gained the islanded set** — and `research.md` §15.3 point 2
   was extended to say so, because the spec only implied it. An islanded remote must contribute **no**
   instance, not merely have its `scope` versions skipped: in the capture `form-overview` is islanded
   on `core` while its `animations` version is still `share` and sole-provider, so skipping versions
   alone leaves `animations@21.2.18` shared beside `core@22.0.8` — the exact Case 3 failure. Covered by
   a dedicated test.
2. **`consumedMembers(members)` returns `Map<RemoteName, ExternalName[]>` for all remotes in one pass**
   instead of `(members, remote)` per remote, which would be O(R²·V) across the per-remote pass.
3. **`singleProviderMembers(instances)` returns `Map<member, remote>`** rather than a `Set`, since the
   caller needs the provider to do the direct assignment, and does not need `members`.

Also: `hostPinnedTags` skips `scope` versions defensively (a host version is always determine's winner,
so this cannot fire today), and `buildAcceptanceTable` unions over a remote's metas for one member —
`process-remote-entries` keeps one meta per (remote, external), so union and intersection coincide.

**Amendment (2026-07-30, Auke):** `buildAcceptanceTable` now accepts **every offered tag when
`strictVersion: false`** — see the qualified §15.1 rule 4 and Hard constraint 5. Found by asking whether
the pool-wide verdict story still holds: the range-only test would have made pooling stricter than the
resolver, islanding loose remotes that dedup today (no pooling spec covers a loose remote, so the suite
would not have caught it). 3 tests added, 799 total. Same pass also trimmed production comments to the
necessary minimum per Auke's instruction; specs keep theirs.

---

## 3 — No-op-pool early-out (W1) + log levels

**Goal:** the two changes that need no new resolution logic. Lands the measurable perf win first and gets
the observability contract in place before behaviour moves.

**Read:** `research.md` §9.2 (W1), §15.1 rule 6, §11.4.

**Files:** `pool-shared-externals.ts` (+ specs).

**Steps**
1. **W1:** `poolFamily` currently rebuilds and `addOrUpdate`s **every member unconditionally**
   (`pool-shared-externals.ts:95-99`), even when `islanded` is empty and nothing changed. Return **before**
   `rebuildMember`/`addOrUpdate` when the pool is a no-op: ~0.13 ms and 13 redundant storage writes per init
   on the capture. Extend the condition in iteration 4 to "no islands **and** nothing re-elected".
2. Upgrade gate-1 islands to **`warn`** once per (pool, remote), naming the member and tag — silent today at
   default level (in non-strict mode `determine` sets `action = 'scope'` with no log at all,
   `determine-shared-externals.ts:179-187`).
3. Suppress the derived warning: when an island in this pass caused a member to lose its last provider,
   `warnIfScopedOnly` must not fire on top (§11.4).
4. Leave the defensive `strictExternalCompatibility` throw untouched.

**Verify:** the 6 existing tests in `pooling.integration.spec.ts` **unchanged and green** · both repro arms
still show the split (nothing is fixed yet) · pooling suite green · types clean · the probe shows the
pooling step **down**, not up.
**Done when:** no-op pools touch no storage, warnings behave per §15.1 rule 6, zero resolution changes.

---

## 4 — Election: host-pinned, remotes-served objective

**Read:** `research.md` §13.2 steps 1–3, §13.4, §15.1 rules 1/3/4, §15.2, §15.3, §8.

**Files:** `pool-shared-externals.ts`, `for-pooling-shared-externals.port.ts` if the signature moves,
`src/lib/core/5.di/init.factory.ts:27`, `src/lib/testing/adapters.mock.ts` if needed.

**Steps**
1. Add `versionCheck` to the step's `ports` and thread determine's **memoized** `isCompatible` through —
   do not build a second memo (§8).
2. **Early-out:** if every member's `share` version already resolves to one instance, skip election.
3. Seed `hostPinnedTags` — those members are chosen and immovable before anything is scored.
4. Assign **single-provider** members directly (§13.2 step 2).
5. Elect the primary instance among candidates from `share`/`skip` versions only: maximise remotes that can
   dedup **entirely** onto it (via the acceptance table), tiebreak fewer chosen instances → size → host →
   declaring remote → name.
6. **Extension pass** for contested members the primary does not ship, preferring the instance that unlocks
   the most remotes.
7. Re-point each chosen member's winner to the chosen instance's tag, with that build **first in `remotes`**
   (the serving basis, per PR #62 — `remotes[0]` is a basis, never a demand), then re-derive verdicts via
   `applyWinner` from iteration 1. `versionDemands` must keep seeing the whole version.

**Verify:** repro **Case 1** flips — `core` + `router` both shared from mfe-a, mfe-b scoping `core` · repro
**Case 2 unchanged and still mixed** (§15.6 — this is expected, not a failure) · the 6 existing integration
tests unchanged · pooling + determine suites green · types clean · `npm run lint`.
**Done when:** Case 1 coherent, capture down to 17 downloads, no existing expectation changed, DI/mocks
updated.

---

## 5 — Per-remote all-skip-or-all-scope + fixed point

**Read:** `research.md` §13.1 F2, §13.2 steps 4–5, §15.1 rule 5, §15.4.

**Files:** `pool-shared-externals.ts` (+ specs).

**Steps**
1. After election, for each remote **not** already islanded by gate 1: if it cannot take every member it
   consumes from the chosen instances (`canTakeAllFrom`), scope its **whole** family from its own build.
2. A member whose only remaining consumers are scoped is not shared at all (scope-only).
   `rebuildMember`'s existing "winner islanded away" branch (`:132-136`) already handles the per-member
   output.
3. **Fixed point** (§15.4): repeat only while the previous round scoped someone.
4. `debug` when a remote ends up drawing from >1 instance; `warn` when it is islanded.

**Verify:** capture — `form-overview` islanded, shared set Angular-22 only, **17** downloads · Point 4 fixture
2 downloads / 0 islands · patch+ragged shapes island nobody · the 6 integration tests unchanged · types clean.
**Done when:** no remote ever mixes instances except the documented Case 2 shape, and the fixed point
terminates.

---

## 6 — Dynamic-init mirror (additive only)

**Read:** `research.md` §15.5 (§7 is the superseded wording).

**Files:** `pool-dynamic-externals.ts` (+ spec).

**Steps**
1. Replace the bare `memberActions.includes('scope')` check with: dedup only if the loaded remote can take
   **every** member it consumes from the **committed** instances (`remotes[0]` of each committed `share`
   version), judged by its own `requiredVersion`. Otherwise scope the whole family.
2. **Strictly additive** — never re-point or mutate a committed version; no election here, the import map is
   immutable (`overrideCachedRemotes` constraint).
3. Reuse iteration 2's primitives; keep the existing tag-only/auto-pooling early-out first, and
   `memberActions.includes('scope')` as the outer gate.

**Verify:** dynamic pooling specs + `pooling.integration.spec.ts`'s dynamic test green · a new spec where the
loaded remote cannot take a committed member ⇒ whole family scoped · a new spec proving no committed version
was mutated · types clean.
**Done when:** the dynamic path enforces §15 without touching committed state.

---

## 7 — Warm-init dirty-gated skip (W2)

**Read:** `research.md` §9 item 3, §9.1–§9.2. Measured: pooling is **45% of a warm init** (0.218 of
0.48 ms) recomputing an unchanged result; determine costs 0.008 ms there.

**Steps**
1. Have `determine` record which externals it elected this pass (it clears `dirty` before pooling runs, so
   pooling cannot infer it). Smallest viable signal — a set on the step result or a repo query. Note
   `dirty` is now set unconditionally when a remote joins an existing version (PR #62 finding 1,
   `process-remote-entries.ts:87`), so the signal is trustworthy on the join path.
2. Pooling skips pools with no touched member.
3. Confirm the untouched path does no per-member work beyond the scope walk.

**Verify:** full suite green · a spec proving a second `init` with unchanged entries performs no pooling
mutation · probe shows warm pooling ≈ 0 · types clean.
**Done when:** warm init with no new remotes does no pooling work.

---

## 8 — Regression + fixture specs

**Steps**
1. Rename `split-family.repro.spec.ts` → a permanent regression spec. The **Case 1** arm asserts the fixed
   behaviour (flipped in 4). The **Case 2** arm keeps asserting the mixed result, with a docblock stating it
   is the documented consequence of absolute host priority (§15.6) and naming the authoring fix
   (`~22.0.6`) — it is a specification, not a known-bug marker.
2. Add the **Point 4** fixture: r1 `core+router@21.2.2`, r2 `@21.2.3`, both `~21.2.0`, winners split across
   builds ⇒ assert both members served from one instance, 0 islands, 2 downloads.
3. Add the **Case 3** guard (§1): a fixture where an islanded remote is the *sole provider* of a member
   (Angular-21 `animations` beside Angular-22 `core`) ⇒ assert the shared set never spans instances that a
   consumer's range would reject. This is the real capture's failure and no per-remote gate catches it.
4. Add the **Case 5** nested/asymmetric fixture (§15.2): `remote1 = {core, common, material}`,
   `remote2 = {core, common}` ⇒ remote1's instance elected, 3 downloads, 0 islands. This is the regression
   test for "remotes-served, not size".
5. Add a `warn` assertion for an island, a **`debug`-not-`warn`** assertion for a multi-instance draw, and a
   no-double-warn assertion (§11.4).

**Verify:** `npm test` green **including coverage thresholds** · types clean.
**Done when:** the regression is locked in and coverage gates pass.

---

## 9 — Docs

**Steps**
1. Rewrite `docs/version-resolver.md` §"How pooling resolves" around the **family-instance** model; fix the
   false claim at **line 599** ("coherence is a property of _versions_ … not of a common source" — the repro
   falsifies it: a split family contains no incompatibility, so islanding never fires); update the mermaid
   flow to show election → per-remote acceptance.
2. Document the **authoring rule** prominently: a remote whose real coupling is tighter than its declared
   range must declare it (`~22.0.6`, not `^22.0.0`), and why (host priority + honest-range assumption,
   §15.6).
3. Add an "unscoped lockstep families" subsection: react/react-dom recipe, and state that **one** remote's
   `pool` tag pools the family portfolio-wide (§11.6).
4. Fix the stale docblock at `pooling.integration.spec.ts:24` ("resolve from one remote build").
5. Document the new log lines so operators can act on them.

**Verify:** `npm run lint` · docs match the shipped behaviour (spot-check each claim against code).
**Done when:** no doc statement contradicts the implementation.

---

## 10 — Final gates + PR

**Steps**
1. `npm test` · `npx tsc --noEmit -p tsconfig.build.json` · `npm run lint` · `npm run knip`.
2. Re-read `research.md` §13.3/§14.1/§15 and confirm every measured row matches actual behaviour; correct
   whichever is wrong.
3. Release framing is **decided: patch** (§11.7). Release notes must say pooled families may island where
   they previously mixed builds.
4. PR against `main` closing #63: the two repro cases, the family-instance model, the regression from #56,
   the measured download improvements (capture 29 → 17), the documented Case 2 limitation, and the perf
   notes from §9.

**Verify:** all four gates green.
**Done when:** PR open, #63 linked.
