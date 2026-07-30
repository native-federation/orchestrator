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

> **SPEC = `research.md`'s header box** (SPEC AS BUILT, 2026-07-30): no election, per-remote agreement
> gate at **minor** granularity (§5.2 + §12.3 + §14's test B). §13–§15's *election* is superseded —
> **do not implement from it**. §4's I1/I2/I3 describe what is built, with agreement read at minor
> granularity rather than exactly.

## Status

- [x] 0 — Branch + baseline
- [x] 1 — Extract `applyWinner` (pure refactor)
- [x] 2 — Family-instance primitives (pure, unit-tested)
- [x] 3 — No-op-pool early-out (W1) + log levels
- [x] 4 — Election (BUILT, MEASURED, REVERTED — see below)
- [x] 5 — Per-remote agreement gate (minor granularity) + fixed point
- [x] 6 — Dynamic-init mirror (additive only)
- [ ] 7 — Warm-init dirty-gated skip (W2 — 45% of warm init)
- [ ] 8 — Regression + fixture specs
- [ ] 9 — Docs
- [ ] 10 — Final gates + PR

## Hard constraints (re-read every pass)

**The model** (`research.md` header box + §16). A **build** (one remote's whole set of `(member → tag)`) is
internally consistent *by construction*; pooling's only job is to stop a remote drawing on builds that
**disagree**, judged at **minor granularity**. Determine's winners are never moved, so host precedence and
`requiredVersion` acceptance are already settled before pooling runs — pooling grants no dedup that
`determine` did not already grant (§16.1 finding 3).

> Superseded wording, kept so a stale copy is recognisable: earlier passes of this file said the unit of
> decision was a *family instance*, tolerance was the remote's declared `requiredVersion`, and there was
> "no tag-distance concept anywhere". That was §13–§15's **election** design, reverted 2026-07-30. Minor
> granularity *is* a tag-distance concept and it is now the only test.

1. **Host wins, always** — priority #1, above pooling. Nothing is ever re-pointed, so this holds by
   construction: in Case 2 the host keeps its pin and the remote that would mix builds gives way.
2. **Membership** unchanged: `pool` tag / npm scope → connected components (`pool-graph.ts`).
3. **No election.** Winners are determine's; pooling only decides who may dedup onto them. Reverted
   2026-07-30 after measurement — see §"SPEC AS BUILT" and the iteration 4+5 write-up.
4. **Agreement is the test, at minor granularity.** Two builds agree when every member they both ship
   sits on the same minor line. `22.0.6` beside `22.0.8` is fine; `22.0.5` beside `22.1.0` is not. No
   `requiredVersion` acceptance test and no `versionCheck` dependency in pooling.
5. **A remote may draw on several builds** as long as they agree — patch drift inside a family is normal
   (`debug`). Disagreement islands it across the **whole** family. No partial mixing.
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

**Known limitations.** §15.6's Case 2 limitation is **gone** — the gate fixes it with host precedence intact,
and both repro arms assert the fix. What remains:

- **F-A, the islanding cascade** (`research.md` §16.2) — one extra previous-major remote takes 7+`eight` from
  36 to **64** downloads and islands **5 of 8**, three of them healthy Angular-22 remotes islanded by
  contagion. Pre-existing #56 behaviour, surfaced by measurement; **does not block #63**, but must be
  recorded in the release notes and ideally filed as a follow-up issue. The shipped gate is structurally
  subtractive and cannot address it — any fix has to re-point winners.
- **Point 4 patch drift is tolerated**, not unified (§12.3's known give-up, now unmitigated by election).
- **Thin real-world validation**: the minor-line gate fires on no real portfolio (§16.1 finding 2).

**Release**: **patch** (§11.7, Auke 2026-07-29). Note in the release notes that pooled families may island
where they previously mixed builds.

**Performance** (§9) — explicit user constraint, *no unnecessary calculations*:
1. `!useAutoExternalPooling && !hasPoolTag()` stays the first statement in the step.
2. ~~Acceptance table + single-provider assignment, mandatory~~ — **both dropped with election.** Pooling
   holds no `versionCheck` dependency and makes no compatibility call at all; it compares tags only.
3. Early-out before touching instances when a single build already serves every member
   (`pool-shared-externals.ts:166`) — this is the healthy-portfolio path and must stay free.
4. No-op pools write nothing (W1, iteration 3).
5. Fixed point re-entered only after an actual island.
6. Allocation discipline (cf. `7bec314`, `3000f6c`): reuse maps, index loops in inner passes.

**Measured baseline** (`research.md` §9.1, capture and probes in `benchmark/`, **git-ignored — local
testing only**; `benchmark/probes/{perf,outcome}-probe.spec.ts`, copy into `src` to run, then delete,
since a spec under `src` counts against the coverage gates): cold init 2.06 ms total — process 0.82 / determine 0.38 /
pool 0.51 / importMap 0.36. Warm init 0.48 ms total, of which **pooling is 45%** and determine is
0.008 ms. `buildPools` alone 0.086 ms; `isCompatible` during determine 11 calls. Election is *not*
the cost centre — the writes are (W1) and the warm recompute is (W2). Re-measure with the probe after
iterations 3, 4 and 7; a regression in the pooling column is a blocker.

**Expected outcomes — measured as built** (`research.md` §16.1; assert these, and do **not** use §13.3/§14.1,
which are prototype numbers that did not reproduce). Downloads after pooling: captured 7 **36** (determine
36), all 11 **45** (42), 7+`eight` **64** (43), 7+`eleven` **36**, 7+`nine` **36**. Coherence is what the
step buys: majors `{21,22}` → `{22}` and zero split packages on every portfolio. Islands are all range
incompatibility — **zero** by build disagreement on real data, so the gate's measured effect lives entirely
in the two synthetic repro arms. Point 4 (`21.2.2` vs `21.2.3`) is **tolerated, not unified**: same minor
line ⇒ agree ⇒ no island, and the family may sit on two patch tags. Pooling never reduces downloads on a
real portfolio; it trades downloads for coherence (§10).

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

**Result (2026-07-30):** `pooling.integration.spec.ts` **untouched** (`git diff` empty) and green; both
repro arms still split. Suite **802/802**, types/lint/prettier clean.

Measured with a rebuilt probe (`<scratchpad>/w1-probe.spec.ts.keep`; the 2026-07-29 one died with its
session). Two portfolios from `benchmark/`, W1 toggled off/on in place:

| portfolio | writes off → on | cold ms off → on |
| --- | --- | --- |
| captured 7 (islands `legacy-overview`) | 24 → 24 | 0.34 → 0.42 (noise; identical path) |
| coherent 6 (`two`–`seven`, islands nobody) | **16 → 0** | **0.336 → 0.13–0.165** |

So on the healthy path W1 removes every write and ~55% of the step; where an island exists nothing
changes, as designed. Warm is unaffected (0.12–0.18 either way) — the warm cost is the scope walk plus
`buildPools`, which is W2's target in iteration 7. Note the capture itself is *not* the healthy path: it
islands `legacy-overview`, so its 24 writes stay until election lands.

`islandedRemotes` now returns `Map<RemoteName, {member, tag}>` (first offender per remote) to name the
cause in the warning; `rebuildMember` takes the map and only ever calls `.has()`.

**Spec fallout, worth knowing:** W1 also stops pooling from *reordering* versions in no-op pools —
`rebuildMember` emits `[share, ...skips, ...scopes]` while `store-remote-entry.ts:201` stores them
newest-tag-first. Nothing downstream reads `versions[0]` except determine's `profile.latestSharedExternal`
(`determine-shared-externals.ts:112`), which wants exactly the newest-first order, so this is a small
correctness gain. The repro spec's action-order assertion was updated to assert `tag:action` pairs
instead, which is order-explicit.

**8 unit tests in `pool-shared-externals.spec.ts` changed contract** (not behaviour): they asserted
rebuild *output* for pools that island nobody, which is now never written. They assert the new contract —
`addOrUpdate` not called, verdicts stand on the stored external, pool formation proven by the debug line.
Among them, the F4 test that asserted a scoped-only warning for a member whose provider was islanded is
**inverted** per §11.4 (double-warn suppression) and paired with a new test where sharing is lost
*without* an island, which still warns.

---

## 4 + 5 — Agreement gate at minor granularity (election reverted)

**Read:** `research.md` header box (SPEC AS BUILT, 2026-07-30), §5.2, §12.3, §14.

**Decision (Auke, 2026-07-30): revert the election, fix Case 1 with tag distance.** Election was built,
measured and reverted in three commits (`efc5e70`, `fbfe4c9`, `4a4a4b7`, reverted here). What it cost and
what it bought is recorded in `research.md`'s header box; the short version is 3-4x the pooling step on
every init for a change of outcome in exactly one synthetic fixture.

**What ships:** `scopeRemotesThatMixBuilds` in `pool-shared-externals.ts` plus four helpers in
`family-instance.ts` (`buildInstances`, `consumedMembers`, `servingBuilds`, `minorLine`,
`findDisagreement`). Per remote: the builds it draws on are whoever serves each member it consumes, or
itself where nobody does. One build - fine. Several - they must agree, i.e. every member two of them both
ship sits on the same minor line. Disagreement islands the remote across the whole family. The gate
iterates to a fixed point, since islanding removes a serving build and can leave a member unserved.

**Result (2026-07-30):**
- **Both repro arms now assert the fix.** Case 1: `core` stays shared for mfe-b, mfe-a serves core+router
  from its own build, `router` is no longer shared. Case 2: the **host keeps its pin** and mfe-a gives way
  — so §15.6's documented limitation is gone, and host precedence never had to bend.
- **`benchmark/` is byte-identical to pre-fix behaviour** on all five portfolios (36/45/64/36/36
  downloads, same islanded remotes): `22.0.6` beside `22.0.8` is one minor line, and the cross-major
  Angular-21 remotes were already islanded.
- **Cost +0.05-0.12 ms** on the pooling step (captured 7 cold 0.465-0.540 ms vs 0.34-0.42 at iteration 3;
  election was 1.43-1.91). No `versionCheck` port, no acceptance table, no scoring — the gate compares
  tags only, and it early-outs before touching instances when a single build serves every member.
- Dropped with election: `elect-instance.ts`, the acceptance table, `canTakeAllFrom`,
  `singleProviderMembers`, `hostPinnedTags`, `packageOf`/`packageGroups`, `splitObjectors`, the shared
  `isCompatible` memo plumbing in `init.factory.ts`, and pooling's third constructor argument. Iteration
  1's `applyWinner` extraction stays (determine uses it; it is behaviour-preserving either way).
- 8 new tests across `family-instance.spec.ts` (serving builds, `minorLine`, `findDisagreement`) and
  `pool-shared-externals.spec.ts` (minor-line island with its warning, patch drift allowed and logged at
  `debug`, two-round fixed point). **801/801**, coverage 96.17/90.36/95.53/96.8, types/lint/knip clean.

**Note for iteration 6:** the dynamic path should mirror *this* gate (§7's original wording — committed
serving builds plus the loaded remote's own build must agree pairwise), not §15.5's acceptance test.

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

**Result (2026-07-30):** mirrors the *agreement* gate, not §15.5's acceptance test (per the iteration 4+5
decision). `pool-dynamic-externals.ts` gains `sharedExternalsRepo` (DI updated) and, after the existing
`memberActions.includes('scope')` gate, asks `disagreementAcrossCommittedBuilds`: build the committed
instances for the pool's members, take the build serving each one, and require them to agree. A
disagreement scopes the loaded remote's whole family and warns at step 8. Nothing committed is ever
read-modify-written — the step still only mutates `actions`, proven by a spec that snapshots the
committed externals and asserts `addOrUpdate` was never called.

Why the extra check is needed even though init already enforces agreement: init guarantees no *remote*
draws disagreeing builds, but the committed shared set can still hold two that disagree when no remote so
far consumed both — the capture's `@framework/forms@22.0.8` beside `@framework/forms/signals@21.2.18`. A
remote loaded later is exactly the consumer that would bridge them.

**Worth recording:** builds that ship **disjoint** members agree vacuously — I2 compares only members two
builds *both* ship. My first fixture missed this and asserted a scope that (correctly) did not happen. In
the real capture the Angular-21 build ships `forms` *and* `forms/signals`, so the shared member `forms`
is what makes the disagreement visible. Ragged coverage staying cheap is the same property (§4's I2
rationale), so this is intended, not a hole.

3 tests added (disagreeing committed builds ⇒ whole family scoped + warning; patch-drift-only committed
builds ⇒ dedup preserved; no committed state mutated). **804/804**, coverage 96.21/90.43/95.55/96.82,
types/lint/knip clean.

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
> **Rewritten 2026-07-30.** The earlier steps asserted *election* outcomes (Point 4 unified to one instance,
> Case 5 electing remote1's instance, Case 2 staying mixed). None of those are the shipped behaviour — see
> `research.md` §16.1.

1. Rename `split-family.repro.spec.ts` → a permanent regression spec. **Both arms assert the fix.** The
   Case 2 arm's docblock states what it proves: the host keeps its pin, the mixing remote gives way, so
   coherence and absolute host priority are not in tension (retiring §15.6).
2. **Point 4 as a *tolerance* test**, not a unification test: r1 `core+router@21.2.2`, r2 `@21.2.3`, both
   `~21.2.0` ⇒ assert **0 islands** and that the gate logs the multi-build draw at `debug`. The family may
   legitimately sit on two patch tags; the guard is that benign patch drift is never islanded.
3. **Case 3 guard** (§1) — a fixture where an islanded remote is the *sole provider* of a member (Angular-21
   `animations` beside Angular-22 `core`) ⇒ assert the Angular-21 members leave the shared set entirely
   (`majors={22}`, zero split packages). Note the mechanism is islanding + `rebuildMember` stripping the
   last provider, **not** election; measured on the capture at §16.1.
4. **Case 5, asymmetric coverage** (§15.2) — `remote1 = {core, common, material}`, `remote2 = {core, common}`
   ⇒ assert **0 islands and no gratuitous scoping** (I3). With no election there is no instance to elect;
   the regression this locks is over-islanding of a clean subset consumer.
5. Add a `warn` assertion for an island (naming member + both tags), a **`debug`-not-`warn`** assertion for an
   agreeing multi-build draw, and a no-double-warn assertion (§11.4).
6. **Characterisation test for F-A** (§16.2): the cross-major cascade shape ⇒ assert the current (expensive)
   outcome with a docblock naming F-A, so a future fix surfaces as a deliberate change rather than a
   surprise diff.

**Verify:** `npm test` green **including coverage thresholds** · types clean.
**Done when:** the regression is locked in and coverage gates pass.

---

## 9 — Docs

**Steps**
1. Rewrite `docs/version-resolver.md` §"How pooling resolves" around the **agreement gate**: determine's
   winners stand, and pooling decides only who may dedup onto them. Fix the false claim at **line 599**
   ("coherence is a property of _versions_ … not of a common source" — the repro falsifies it: a split family
   contains no incompatibility, so islanding never fires). Update the mermaid flow to show
   *islanded-remotes → agreement gate (fixed point) → rebuild*, **not** election.
2. State the **download trade** plainly (§10, §16.1): pooling buys coherence and can cost downloads — it
   never reduced them on any measured portfolio. Do not repeat "strictly better everywhere".
3. Document the **authoring rule** with its real scope: declaring tighter coupling (`~22.0.6`, not `^22.0.0`)
   is still the right advice, but note it now routes only through `determine`'s `scope` verdict — pooling
   itself never reads `requiredVersion` (§16.1 finding 3), and patch-level coupling inside one minor line
   needs an exact pin to be enforced at all.
4. Add an "unscoped lockstep families" subsection: react/react-dom recipe, and state that **one** remote's
   `pool` tag pools the family portfolio-wide (§11.6).
5. Fix the stale docblock at `pooling.integration.spec.ts:24` ("resolve from one remote build").
6. Document the new log lines so operators can act on them — including that an agreeing multi-build draw at
   `debug` is normal and needs no action.

**Verify:** `npm run lint` · docs match the shipped behaviour (spot-check each claim against code).
**Done when:** no doc statement contradicts the implementation.

---

## 10 — Final gates + PR

**Steps**
1. `npm test` · `npx tsc --noEmit -p tsconfig.build.json` · `npm run lint` · `npm run knip`.
2. Re-run both probes and confirm every row of `research.md` **§16.1** still matches; correct whichever is
   wrong. Do **not** validate against §13.3/§14.1 — they are prototype numbers, marked as not reproduced.
3. Release framing is **decided: patch** (§11.7). Release notes must say: pooled families may island where
   they previously mixed builds; the fix buys **coherence, not downloads** (§16.1 finding 1); and the
   agreement gate fires on no portfolio in `benchmark/`, so real-world exposure is small and so is
   real-world validation (finding 2).
4. PR against `main` closing #63: the two repro cases (both fixed, host precedence intact), the agreement
   gate at minor granularity, the regression from #56, the measured outcomes from §16.1 — **not** the
   superseded 29 → 17 claim — and the perf notes from §9.
5. File **F-A** (§16.2) as a follow-up issue and link it from the PR as a known limitation, so the cascade
   does not disappear with the reverted election.

**Verify:** all four gates green.
**Done when:** PR open, #63 linked.
