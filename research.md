# Pooling: split monorepo families (regression from #56)

> ## SPEC AS BUILT (Auke, 2026-07-30): no election, agreement gate at minor granularity
>
> **§15's election is reverted.** Measured on `benchmark/` it changed the outcome of exactly one shape —
> synthetic Case 1 — while costing **3–4x the pooling step on every init** (captured 7: 1.43–1.91 ms
> against 0.34–0.42 ms), and on two portfolios it made things actively worse until a package-coherence
> guard was added to hold it back. Its whole benefit was reachable far more cheaply.
>
> **What ships instead is §5.2's per-remote agreement gate with §12.3's minor-line granularity — i.e.
> §14's test B, revived as the *only* coherence test.** A remote may draw on several builds (patch drift
> inside a family is normal and safe), but not on builds that **disagree**: every member two of them both
> ship must sit on the same minor line. A remote whose builds disagree serves its whole family from its
> own build. Islanding is monotone, so the gate iterates to a fixed point.
>
> Consequences, all measured:
> - **Case 1 is fixed**, and so is **Case 2** — §15.6's "accepted limitation" no longer applies, and
>   **host precedence is untouched**: in Case 2 the host keeps its pin and `mfe-a` gives way.
> - **Every portfolio in `benchmark/` is byte-identical to pre-fix behaviour** (36/45/64/36/36 downloads,
>   same islanded remotes), because `22.0.6` beside `22.0.8` is the same minor line while the cross-major
>   Angular-21 remotes were already islanded.
> - Cost: **+0.05–0.12 ms** on the pooling step (captured 7 cold 0.465–0.540 ms), no `versionCheck`
>   dependency, no acceptance table, no scoring — the gate compares tags only, as §5.2 said it would.
>
> So §13–§15's family-instance *election* is superseded reasoning; §13.1's F1/F2 survive in the form
> "one build, or your own", and §4's I1/I2/I3 are the closest description of what is implemented, with
> agreement read at minor granularity rather than exactly. §15.1 rule 4's `strictVersion` qualification
> and §15.3's islanded-instance clause still apply to the primitives; rules 1 and 3 (host seeding,
> election objective) are moot — nothing is ever re-pointed.

Tracking issue: [#63 "bug: pooling should be on exact versions"](https://github.com/native-federation/orchestrator/issues/63) · branch `issues/63`
Status: **designed, measured, not implemented** — see `plan.md`. **§15 is the spec**; §13 defines the
model it uses, §14 records why the cross-instance guard was considered and rejected. §4–§5, §7 and §12.3
are superseded, kept only for the reasoning trail (§7 is restated in instance terms as §15.5).
All open questions closed 2026-07-29 (Auke): release = **patch** (§11.7) · multi-instance draw logs at
**`debug`**, islanding at **`warn`** (§15.1 rule 6) · election objective outranks every tiebreak, instance
count above size (§15.1 rule 3) · determine's verdicts and the existing island gate are unchanged (§15.3) ·
the per-remote pass iterates to a fixed point (§15.4) · dynamic init stays strictly additive (§15.5) ·
Case 2 is an accepted consequence of absolute host priority (§15.6).
Repro: `src/lib/core/2.app/steps/pooling/split-family.repro.spec.ts` (uncommitted; 2 tests, both
green on `main` = both bugs live).

> **Note on the issue title.** "exact versions" is loose shorthand. Cohesion here is *same serving
> build*, not *same tag* (§4) — a pool may legitimately span version lines, and a whole family
> deduping down to one older-but-consistent build must stay shared (Auke, point 1). The issue body is
> empty; §4's invariants are the spec.

---

## 1. The defect

With `useAutoExternalPooling: true`, a monorepo family whose members are each *individually*
compatible can still be served from two different builds at two different versions. A remote that
consumes both members then runs a mismatched framework family and crashes at runtime.

### Case 1 — a strict pin drags one member down

| remote | `@angular/core` | `@angular/router` |
| --- | --- | --- |
| `team/mfe-a` | `22.1.0`, req `^22.0.0` | `22.1.0`, req `^22.0.0` |
| `team/mfe-b` | `22.0.5`, req `~22.0.5` (strict) | – |

`determine-shared-externals` output (verified, not hypothetical):

```
@angular/core:   22.0.5[share]<-team/mfe-b | 22.1.0[skip]<-team/mfe-a
@angular/router: 22.1.0[share]<-team/mfe-a

imports: { core: http://mfe-b/…, router: http://mfe-a/… }      scopes: {}
```

`core` resolves *down* to `22.0.5` because `22.1.0` costs mfe-b an extra download; `router` has no
such pin and only mfe-a provides it, so it resolves to `22.1.0`. mfe-a's own `core@22.1.0` is
deduped away ⇒ **mfe-a runs `router@22.1.0` against `core@22.0.5`**. Pooling was a no-op: no version
carries `scope`, so `islandedRemotes` is empty.

### Case 2 — host precedence (most common real-world trigger)

Host ships `core@22.0.5` and no router. Host precedence pins the shared `core` to the host's tag,
while `router` elects freely from mfe-a:

```
imports: { core: http://host/…, router: http://mfe-a/… }
scopes:  {}                      ← mfe-a again mixed
```

Any portfolio where the host pins the framework and a remote brings a sibling package the host does
not ship reproduces this.

### Case 3 — the production capture, measured (worst of the three)

Running the real 7-remote capture (`benchmark/*.remoteEntry.json`, untracked) through
`processRemoteEntries → determine` with auto-pooling on, the `@angular` pool's **shared set draws on 4
different serving builds**:

```
@angular/animations:              share=21.2.18 <- form-overview      ← Angular 21
@angular/compiler:                share=21.2.18 <- form-overview      ← Angular 21
@angular/platform-browser-dynamic:share=21.2.18 <- form-overview      ← Angular 21
@angular/core:                    share=22.0.8  <- par-document/approve
@angular/common/elements/forms/platform-browser: share=22.0.8 <- par-document/approve
@angular/cdk:                     share=22.0.6  <- par-document/approve
@angular/material:                share=22.0.6  <- par-ticle/mutations
@angular/router:                  share=22.0.8  <- par-ticle-settings/digitaal-inschrijven
```

So `@angular/animations@21.2.18` is globally shared **next to** `@angular/core@22.0.8` — a
**cross-major** split in the shared set. Any remote consuming both loads Angular 21 animations against
an Angular 22 core.

**The mechanism is one neither synthetic case shows, and it is why I1 must be its own invariant.**
`form-overview` (Angular 21) *is* correctly islanded — it carries `scope` on core/common/elements/
forms/platform-browser/router. But it remains the **sole provider** of animations, compiler and
platform-browser-dynamic, so those members stay globally shared *at its version*. Islanding governs
whose copies get deduped; it says nothing about who serves a member nobody else ships. No per-remote
gate can repair that — the shared set itself is incoherent.

---

## 2. Root cause

Two independent facts combine:

1. **Winner election is per-external.** `setVersionActions` is called once per external with no
   cross-external state (`determine-shared-externals.ts:60-68`). Its criteria — host flag,
   `profile.latestSharedExternal`, fewest-extra-downloads, tear tiebreak — are per-external signals
   that diverge freely between `core` and `router`.
2. **Post-#56 pooling never touches election.** `islandedRemotes` reads only stored
   `action === 'scope'` verdicts (`pool-shared-externals.ts:13-19`); `rebuildMember` preserves every
   non-islanded copy's base verdict (`:126-136`).

So of the two invariants pooling was created for, only one survives:

- ✅ no foreign build leaks into an **incompatible** remote (no dedup of an islanded remote's siblings)
- ❌ the family resolves in **lockstep** — unenforced

The deeper reason the per-external resolver cannot catch this on its own: `requiredVersion`
under-reports intra-family coupling. mfe-a declares `^22.0.0` for both members, so `core@22.0.5` and
`router@22.1.0` are each individually "accepted" — but `router@22.1.0`'s real coupling to
`core@22.1.0` is a fact of the monorepo, invisible in the remote entry. Pooling exists precisely to
compensate for that missing information; after #56 it no longer does.

### Stale claims to fix

- `docs/version-resolver.md:599` — "coherence is a property of _versions_ (guaranteed by islanding),
  not of a common source". The repro falsifies this: a split family contains no incompatibility, so
  islanding never fires.
- `pooling.integration.spec.ts:25` — docblock still claims pooling "makes a whole `@framework/*`
  family resolve from one remote build". Its first test only *looks* coherent because `^17.0.0`
  happens to dedup mfe-b onto mfe-a.

---

## 3. This is a regression, not a pre-existing hole

Same repro run against `ecf4b0a` (#50's anchor model) — both tests fail, because #50 kept every
remote on a single build:

| | #50 (anchor) | `main` (island-or-defer) |
| --- | --- | --- |
| Case 1 | `router` shared from mfe-a@22.1.0; `core` scope-only ⇒ mfe-a self-serves 22.1.0, mfe-b 22.0.5. **Coherent**, +1 core download | `core@22.0.5` + `router@22.1.0` both shared. **mfe-a broken**, 0 extra downloads |
| Case 2 | mfe-a coverage-forced ⇒ scopes its whole family; host keeps shared `core@22.0.5`. **Coherent**, +1 family download | `core` from host + `router` from mfe-a. **mfe-a broken** |

#56 bought back exactly the downloads F1 complained about by dropping the lockstep guarantee.

**This also re-frames F1.** In the capture, `mutations` "recovering sharing" meant deduping
`core/common@22.0.5` while self-serving four `@angular/cdk|material/*` members. That is only safe if
those members' tags agree with the shared ones — which they did (all `22.0.5`). So F1's fix was
right *for that capture*, but its stated rationale ("coverage ≠ incompatibility, therefore share")
is too weak a test in general: it permits Case 1, where the tags disagree.

---

## 4. Invariants (SUPERSEDED by §13 — kept for the reasoning trail)

Cohesion is **same serving build**, never same tag — a pool can legitimately span version lines
(`@design-system/ui@1.0.0` bridged into the `@framework@17.0.0` family). Three rules, in order:

> **I1 — The shared set is self-agreeing.** For any two globally shared members of a pool, their
> serving builds must agree: every member both builds ship carries the same tag. (A remote consuming
> two shared members that disagree is broken regardless of any per-remote rule, so this cannot be
> delegated to a gate.)
>
> **I2 — Per-remote coherence.** For every remote R and pool P, the builds R draws on for P must
> agree pairwise on every member they both ship — where R's own build counts as one of them for
> members R self-serves. Otherwise R is islanded: whole family from its own build, no dedup.
>
> **I3 — No gratuitous scoping.** A remote whose whole family can dedup coherently is *never*
> islanded, and pooling never promotes a version the resolver marked `scope`.

Why not the obvious alternatives:

- *One serving build per remote* (build identity, #50's rule) is sound but too strict: it islands a
  remote that self-serves a member nobody else has, even when every tag agrees. That is the F1 cost,
  and I3 exists to forbid it.
- *All pool members share one tag* is unsound — see the version-line case above.
- I2 subsumes both: mixing builds is fine as long as they cannot disagree about anything they have in
  common.

---

## 5. Algorithm (SUPERSEDED by §13 — kept for the reasoning trail)

Two phases, both per pool per shareScope (`strict` scope excluded, as today). Election makes the
shared set cohesive (I1); the gate decides per remote (I2, I3).

### 5.1 Pool-aware re-election

Islanding alone is not enough. It yields a coherent result but a degraded topology: in Case 1 `router`
loses its only live provider and becomes scope-only, and because the import map is immutable that is
permanent — a compatible remote added later by dynamic init can never dedup it. Re-election instead
leaves both members globally shared and self-serves only the strictly-pinned remote, for the same
download count.

**Candidate set: versions determine already marked `share` or `skip`.** A `scope` version is never
promoted — promoting one cascades scoping, which is self-defeating (I3).

**Host-declared versions are immovable.** Host precedence stays absolute; where that makes full
cohesion impossible the answer is not to override it (Case 2 in §6).

**Early-out first (perf):** if every member's current `share` version has the same serving build,
the pool is already cohesive — skip election entirely. One pass over members, no scoring, no
compatibility checks. This is the healthy-portfolio path and must stay the cheap one.

Otherwise, greedy:

1. **Offer table**, built once per pool in a single pass over members × versions × remotes: for each
   remote B, the tag it offers per member, counting only `share`/`skip` versions. Election and gate
   both read this table; nothing re-walks the pool per candidate.
2. Score each candidate build: **members offered** (desc) → **newly created scopes** (asc;
   re-electing can make a strictly-pinned remote scope — penalise, don't forbid) → **currently
   cached tag** (desc; tiebreak only — cache is a performance signal, not a stability one, so it must
   never outrank cohesion) → **declared the `pool` tag** on these members → **name** (asc, for
   reload-stability). Membership is portfolio-wide, so the declaring remote is a tiebreak, never a
   privilege.
3. Share everything the winning build offers: re-point each such member's winner to that build's tag,
   with the build first in `remotes` (it becomes the serving basis), then re-derive verdicts via the
   extracted `applyWinner` (§8).
4. **Extension pass** — for each member the winning build does not offer, share it from another build
   that *agrees with the already-chosen set* (I1), by the same scoring order; otherwise leave the
   member without a share version (scope-only for whoever consumes it).

Step 4 is what keeps I3 alive in ragged pools: it is what preserves integration test 3 and the F1
recovery.

### 5.2 Gate (per remote)

1. **Strict-incompatibility gate** (unchanged, outermost): any remote the resolver marked `scope` on
   any member is islanded.
2. **Agreement gate** (new, I2): for each remaining remote, compute the build set it draws on — per
   member, the winner's serving build (`remotes[0]`) where it dedups, its own build where it scopes.
   Pairwise-check only when that set has more than one build (deduping everything gives a set of one
   ⇒ O(1) pass). On violation, island the remote and `warn`.
3. Otherwise keep the per-member verdict.

Islanding is monotone — islanding a remote can strip a winner's last live provider, turning that
member scope-only and pushing another remote into violation — so the gate iterates to a fixed point,
re-running **only** if the previous iteration islanded someone (normally zero extra iterations,
bounded by the remote count). `rebuildMember`'s existing "winner islanded away ⇒ orphaned `skip`
copies self-serve" branch (`pool-shared-externals.ts:132-136`) already produces the right per-member
output.

---

## 6. Worked verdicts (paper analysis — re-verify while implementing)

| fixture | election | gate | outcome |
| --- | --- | --- | --- |
| **Case 1** | candidates mfe-a{core 22.1.0, router 22.1.0} = 2 members, mfe-b{core 22.0.5} = 1 ⇒ mfe-a wins; `core` re-elected to 22.1.0 | mfe-b now strict-rejects ⇒ islanded (gate 1) | both members shared from mfe-a; mfe-b self-serves core. **Fixed**, coherent, same download count as #50 but `router` stays shareable |
| **Case 2** | host's `core@22.0.5` immovable; mfe-a's build disagrees with host on `core` ⇒ extension refuses `router` | mfe-a draws on {host(core), itself(router)} ⇒ disagree ⇒ islanded | shared `core@22.0.5`; `router` scope-only for mfe-a, which self-serves its family. **Fixed** |
| **Point 4** (r1 core+router@21.2.2, r2 @21.2.3, both req `~21.2.0`, split winners) | both builds offer 2 members, 0 new scopes ⇒ tiebreak (cached → declaring remote → name) ⇒ one build wins; both members re-pointed to it | other remote dedups both onto that build (single build ⇒ agrees) | family consistent and single-source, either remote acceptable. **Matches the stated goal** |
| integration test 1 (mfe-b@17.1.0 onto mfe-a@17.0.0) | both offer 2 members; tiebreak → mfe-a | mfe-b draws on one build ⇒ agrees | unchanged from today (I3) |
| integration test 3 (ragged: mfe-a core+common, mfe-b common+forms, all 17.0.0) | mfe-a wins (2 members); extension shares `forms` from mfe-b, which agrees on `common@17.0.0` | mfe-b draws on {mfe-a, itself}, agree on `common` | unchanged — `forms` stays shared, mfe-b dedups `common`. **F1 recovery preserved** |
| integration tests 2, 4, 5 (mfe-c@18 / design-system bridge) | `scope` versions never promoted | islanded by gate 1 | unchanged |
| F1 capture (`mutations`) | its cdk/material members shared from itself at `22.0.5`, agreeing with shared `core/common@22.0.5` | draws on agreeing builds | stays `follow`. **F1 recovery preserved** |

If that holds, no existing expectation changes — election only moves winners inside the compatible
group, and the gate fires only on genuine tag disagreement.

---

## 7. Dynamic init (SUPERSEDED by §15.5 — the constraint below still holds, the gate is restated)

Re-election is **forbidden** here: the committed import map is immutable, so the newly loaded remote is
the only thing that can move. `pool-dynamic-externals.ts:44-55` currently only checks
`memberActions.includes('scope')`; it needs the I2 gate:

> The loaded remote may dedup a family member only if the committed serving builds (`remotes[0]` of each
> committed `share` version) for every member it consumes, plus its own build, agree pairwise.
> Otherwise scope the whole family.

Because init now guarantees the committed side satisfies I1, this reduces in practice to: every member
it consumes must be committed, and it must dedup *all* of them onto the committed builds — no
mixed-with-own-build case survives unless the tags agree.

---

## 8. Re-election vs. entrypoint coverage — decided

`determine` applies the entrypoint-coverage policy as part of election
(`applyEntrypointCoveragePolicy`, `determine-shared-externals.ts:192-219`), and both `findTears` and
`uncoveredTears` key off `winner.remotes[0]!.entries` — the serving basis. Re-election changes the
winner *and* its basis, which would silently invalidate that analysis (PR #62's work).

**Decision (Auke, 2026-07-29): extract the election tail.** A shared
`applyWinner(external, winner, isCompatible)` helper — assign `skip`/`scope` per version, then re-run
`applyEntrypointCoveragePolicy` — called by both `determine` and pooling. One implementation of tear
handling. Rejected: re-running `determine` (it would re-elect by its own heuristic and undo the pool's
choice); a second coverage rule inside pooling.

Two consequences:

- **Pooling gains a `versionCheck` dependency.** Correcting the first draft: re-election *does* need
  compatibility checks, because new `skip`/`scope` verdicts cannot be derived from determine's old
  classification. `createPoolSharedExternals` currently takes only `sharedExternalsRepo`
  (`init.factory.ts:27`) — DI and mocks must be updated. The **gate** still needs no `versionCheck`;
  it compares tags only.
- **Share the memo.** `determine` memoizes `isCompatible` per resolve
  (`determine-shared-externals.ts:45-54`) precisely because the selection loop is O(versions²). The
  same `(tag|requiredVersion)` questions would otherwise be asked again by pooling, so the memoized
  function must be passed in, not recreated.

Also: re-pointing must put the chosen build first in `remotes` (serving basis, per PR #62 —
`remotes[0]` is the basis, never a demand), and `versionDemands` must keep seeing the whole version.

---

## 9. Performance budget

Explicit constraint (Auke): no unnecessary calculations. The design's cost discipline, in priority
order:

1. **Default config stays free.** The existing `!useAutoExternalPooling && !hasPoolTag()` early-out
   (`pool-shared-externals.ts:39-41`) remains the first statement; nothing in §5 runs for it.
2. **Cheap path for healthy pools.** §5.1's single-build early-out means candidate scoring and every
   `isCompatible` call happen only in split or ragged pools. A coherent portfolio pays one pass over
   members per pool.
3. **Warm init.** Pooling currently re-walks every non-strict scope and every external on *every*
   init. `determine` clears `dirty` before pooling sees it, so pooling cannot tell what changed —
   have `determine` record the externals it elected and let pooling skip pools with no touched member.
   Aim: a warm init with no new remotes does no pooling work beyond the scope walk.
4. **One offer table per pool**, built in a single pass over members × versions × remotes and read by
   both phases. No per-candidate re-walk, no `flatMap` chains inside candidate loops.
5. **Bounded compatibility work.** Reuse determine's memo (§8) so the distinct question count stays
   `(distinct tag × distinct requiredVersion)` within the pool. Do **not** replicate determine's
   O(versions²) selection loop inside pooling.
6. **Gate is O(V) per iteration**, pairwise agreement computed only for remotes drawing on >1 build,
   fixed point re-entered only after an actual island.
7. **Allocation discipline** — consistent with `7bec314` (hot-path allocations) and `3000f6c` (warm
   init): reuse the offer table's maps, keep `rebuildMember`'s single `flatMap` per member, prefer
   index loops in inner passes.

Complexity with V = version metas in the pool, R = remotes, M = members: offer table O(V); election
O(V + R·M) **only** when the early-out misses; gate O(V) per iteration.

### 9.1 Measured baseline (production capture, `benchmark/*.remoteEntry.json`)

Mean over 60 cold runs / 100 warm runs, jsdom, auto-pooling on. Probe kept at
`benchmark/probes/perf-probe.spec.ts` (git-ignored, local only).

| step | cold ms | warm ms (all remotes cached ⇒ skipped) |
| --- | --- | --- |
| processRemoteEntries | 0.82 | 0.005 |
| determineSharedExternals | 0.38 | **0.008** |
| poolSharedExternals | 0.51 | **0.218 (45% of warm init)** |
| generateImportMap | 0.36 | 0.250 |
| **total** | **2.06** | **0.48** |

Shape: 18 shared externals in the global scope, **12 single-version** (determine short-circuits at
`versions.length === 1`) and only 6 multi-version, 29 versions / 66 metas total, 2 pools with 13
members. `isCompatible` during determine: **11 calls, 11 distinct** — the memo never even gets a hit.
`buildPools` in isolation on clean storage: **0.086 ms**.

### 9.2 Verdict on the "elect pool members inside determine" alternative — rejected on measurement

Teaching `determine` to elect a family jointly would avoid re-election, so it looked like the cheaper
design. The numbers say it isn't:

1. **Election is not the cost centre.** 0.38 ms cold, 0.008 ms warm, 11 compatibility calls total.
   12 of 18 externals never reach the selection loop. The double work option 1 pays is a fraction of
   that fraction.
2. **It keeps the actual cost.** Pooling's 0.218 ms warm is `buildPools` (0.086) plus `rebuildMember`
   and 13 `addOrUpdate` writes. The alternative still needs the pool graph — only earlier — and still
   needs the gate, the rebuild and the writes. It removes none of it.
3. **It costs architecture:** pool graph before determine, resolver coupled to pooling, joint election
   over partially-dirty pools, and the "layered re-resolution" model both #50 and #56 rest on.

Where the measured wins actually are, both available inside option 1:

- **W1 — no-op pools must not write.** `poolFamily` currently rebuilds and `addOrUpdate`s **every
  member unconditionally**, even when `islanded` is empty and nothing changed
  (`pool-shared-externals.ts:95-99`). With no islands and no re-election the pool is a no-op, so it
  should return before touching storage: ~0.13 ms and 13 redundant writes per init on this capture.
- **W2 — dirty-gated skip (§9 item 3).** A warm init spends 45% of its time in pooling to recompute an
  unchanged result. Gating on "some member was elected this pass" removes it.

W1 alone roughly halves the pooling step in the healthy case, which is more than the rejected
alternative could have saved anywhere.

---

## 10. Cost

Coherence is not free: a remote whose tags disagree with the shared family downloads that whole
family. That is the trade #56 sold off, and it is real for ragged portfolios. Per the 2026-07-29
decision, **coherence wins by default** — the escape hatch is to not pool the family (auto-pooling
off, no `pool` tag), not a per-portfolio knob. Re-election and I3 exist to keep that cost minimal
rather than to accept it.

---

## 11. Decisions (2026-07-29)

All previously open questions are closed. Execution order lives in `plan.md`.

1. **Election tail** → extract `applyWinner` (§8).
2. **Cached tag in scoring** → tiebreak only, below "newly created scopes". Cache is a performance
   signal, not a stability one; letting it outrank cohesion would make the shared set depend on load
   order.
3. **Logging** → **upgrade both gates to `warn`.** A gate-2 island warns once per (pool, remote) with
   the disagreeing member and both tags; gate-1 islands, silent today at default log level (in
   non-strict mode `determine` sets `action = 'scope'` with no log at all —
   `determine-shared-externals.ts:179-187`), are upgraded too.
4. **Double-warn** → suppress the derived one: when an island in the same pass caused a member to lose
   its last provider, `warnIfScopedOnly` must not fire on top of the island warning.
5. **`strictExternalCompatibility`** → does **not** throw on a disagreement. `strict: true` fans out
   to all six flags (`mode.config.ts:6-14`), so that would hard-fail valid ragged portfolios where no
   declared range is violated. A dedicated `strictPoolCoherence` remains available later, additive and
   non-breaking. The existing defensive gate-1 throw (`pool-shared-externals.ts:87-93`) stays.
6. **Unscoped lockstep families** (react/react-dom) → status quo plus docs. `autoScope` only matches
   `/^@([^/]+)\//` (`pool-graph.ts:6, 71-73`) and inference is impossible — `DenseSharedInfo` carries
   no `peerDependencies`. **Corrected F5 framing:** a `pool` tag is remote-local for *membership* only,
   while `buildPools`/`islandedRemotes`/`rebuildMember` operate on the whole `SharedExternal`, so
   **one** remote declaring `pool: 'react'` on `react` + `react-dom` pools that family portfolio-wide,
   including remotes that never declared a tag. Document that property with the react/react-dom recipe.
7. **Release** → **patch** (Auke, 2026-07-29). It is a bugfix behind an opt-in flag; the API surface does
   not change. The earlier argument for a minor (resolution outcomes change for anyone who enabled
   pooling) is outweighed by the fact that the outcomes it changes were **incoherent** — and, as measured
   in §15, the fix is *cheaper* in downloads in every shape except Case 2, so there is no upgrade cost to
   signal. Note for the release notes: pooled families may island where they previously mixed builds.

---

## 12. Scaling (measured 2026-07-29) — **one open decision**

Probe: `<scratchpad>/scale-probe.spec.ts.keep`. Synthetic portfolios through the real
`processRemoteEntries → determine`, then the §5 algorithm prototyped outside `src`. `drift` = how many
distinct tags the family carries across remotes; `unique` = whether some remotes ship a family member
nobody else ships (ragged coverage, the F1/F2 shape). Downloads = shared members + per-islanded-remote
copies + scope-only copies.

### 12.1 Runtime — scales

| shape | R | M | determine | pool today | new phases |
| --- | --- | --- | --- | --- | --- |
| drift=none unique=y | 50 | 80 | 0.26 ms | 1.29 ms | 3.73 ms |
| drift=patch unique=y | 50 | 80 | 1.44 ms | 1.23 ms | 1.71 ms |
| members sweep | 25 | 145 | 3.05 ms | 1.67 ms | 1.67 ms |

Linear in M (0.42 → 0.62 → 1.00 → 1.67 ms for M = 35/55/85/145 at R=25), same order as the steps that
already exist. **But note row 1:** the worst runtime is a *fully coherent* portfolio, where the gate
still walks O(R·M). The §5.1 single-build early-out and W1 are therefore not optimisations, they are
what keeps the healthy path off that walk.

### 12.2 Outcome — exact-tag coherence does **not** scale

Downloads, exact-tag agreement (what §4 currently specifies) vs today:

| shape | R | today | exact | islands |
| --- | --- | --- | --- | --- |
| drift=patch unique=**n** | 25 | 90 | **30** | 0/25 |
| drift=patch unique=**n** | 50 | 90 | **30** | 0/50 |
| drift=patch unique=**y** | 25 | 115 | **426** | 17/25 (68%) |
| drift=patch unique=**y** | 50 | 140 | **792** | 33/50 (66%) |
| drift=major unique=n | 50 | 409 | 379 | 16/50 |
| M=120 sweep | 25 | 381 | **1535** | 16/25 |

Two regimes, and the discriminator is **ragged coverage**:

- **Uniform coverage** — coherence is a large *win*: election aligns the whole family onto one build,
  downloads drop 3× (90 → 30) and nothing islands.
- **Ragged coverage + patch drift** — coherence costs **3–6× downloads**, growing with both R and M.

The traced mechanism (from the probe's own diagnostic):
`team/mfe-0 drew {mfe-0, mfe-13, mfe-19, mfe-7} -> mfe-0 X mfe-13 [pkg-00: 22.0.5 vs 22.0.6]`. A remote
that is the sole provider of one member must self-serve it from its own build, so it draws its own build
*alongside* the shared ones; those disagree at **patch** level, so I2 islands its entire family. With T
distinct tags in a family, roughly (1 − 1/T) of the sole-provider remotes island — and no election
policy fixes it: a "modal tag" policy (prefer the tag most remotes ship) moved islands only 17→16 of 25.

### 12.3 The lever: agreement granularity (RESOLVED — see §13; tolerance is `requiredVersion`, not a tag granularity)

Comparing tags at `major.minor` instead of exactly:

| shape | R | today | exact | **minor** |
| --- | --- | --- | --- | --- |
| drift=patch unique=y | 25 | 115 | 426 | **55** (0 islands) |
| drift=patch unique=y | 50 | 140 | 792 | **80** (0 islands) |
| drift=major unique=y | 50 | 459 | 792 | **429** (16/50 islands) |
| M=120 sweep | 25 | 381 | 1535 | **145** (0 islands) |

Minor-granularity agreement is **better than today in every measured configuration**, islands nothing
on patch drift, and still islands cross-major. It also still catches every case in §6: Case 1 and Case 2
differ at *minor* (22.0.5 vs 22.1.0), Case 3 differs at *major* (21.2 vs 22.0).

**What it gives up** is precisely Auke's point-4 example (`21.2.2` vs `21.2.3` — same minor). Note the
asymmetry: under minor granularity the *shared set* would still be exactly lockstep whenever election
picks a single build (I1), so point 4's stated goal — "versions consistent, from the same remote" — is
met for everything globally shared. The relaxation only permits a **sole-provider remote** to self-serve
its unique member at a different patch than the shared family.

**Open decision (blocks iterations 3–4):**

1. **Exact** — as §4 specifies. Maximum safety, 3–6× downloads on ragged+patch-drift portfolios.
2. **Minor for I2, exact for I1** — shared set stays exactly lockstep; only sole-provider self-serving
   tolerates patch drift. *Recommended.* My prototype's numbers for this specific split were internally
   inconsistent (a granularity-caching flaw in the probe), so it needs a clean run before committing.
3. **Minor for both** — measured, cheapest, but the shared set may then mix patch versions.

Whatever is chosen, the granularity belongs in one predicate so it is a one-line change, and §4's I1/I2
wording must state it explicitly.

---

## 13. Family-instance model — **current spec** (supersedes §4–§5, resolves §12.3)

Auke's reframing, 2026-07-29: stop comparing tags. The unit of decision is a **family instance** — one
remote's build, i.e. the whole set of `(member → tag)` it ships, which is internally consistent *by
construction*. Tolerance is the remote's declared **`requiredVersion`**, not a hardcoded granularity:
"I don't mind if the final shared version is a different version, that's what the requiredVersion range
is for. I want all members to be consistent."

### 13.1 Invariants

> **F1 — Consistency by single source.** A remote takes every member it consumes from a **chosen family
> instance** (its own included) whose tag its declared range accepts. Consistency comes from *one
> build*, not from equal tags.
>
> **F2 — All-skip or all-scope.** If a remote cannot take every member it consumes from the chosen
> instances, it scopes its **whole** family from its own build. No partial mixing.
>
> **F3 — The shared set may span tags.** Different members may be served by different instances,
> provided every consumer's range accepts every tag it receives. (Measured on the capture: shared
> `cdk@22.0.6` beside `core@22.0.8` — legal, because every consumer's range accepts both.)

### 13.2 Algorithm

1. **Elect the primary instance.** Objective: **the number of remotes that could dedup *entirely* onto
   it**, tiebreak instance size, then host, then declaring remote, then name.
   **"Biggest" is the wrong metric** — measured on the production capture it islands 6 of 7 remotes and
   costs 46 downloads vs 17, because the biggest instance there is the Angular-**21** remote (37 shared
   entries). Size correlates with compatibility only when versions already agree; remotes-served is the
   objective Auke's intent points at.
2. **Assign single-provider members directly.** A member only one instance ships has no decision to
   make — assign it, never score it. (This is also the difference between 4 ms and 262 ms; see §13.4.)
3. **Extend for contested members**, preferring the instance that unlocks the most remotes.
4. **Per remote: all-skip or all-scope** (F2), by testing its declared ranges against the chosen tags.
5. A member whose only remaining consumers are islanded is not shared at all (scope-only).

### 13.3 Measured outcome — strictly better than today, everywhere

| fixture | today | family model | verdict |
| --- | --- | --- | --- |
| **Case 1** (strict pin) | 3 dl, **broken** | 3 dl, shared `core+router@22.1.0`, mfe-b islanded | fixed, no extra cost |
| **Case 2** (host pins core) | 3 dl, **broken** | **2 dl**, 0 islands, shared `core+router@22.1.0` | fixed **and cheaper** |
| **Case 3** (production capture) | 29 dl, **broken** (Ng21 beside Ng22) | **17 dl**, form-overview islanded, shared set Angular-22 only | fixed, **41% fewer downloads** |
| **Point 4** (21.2.2 vs 21.2.3) | 4 dl | **2 dl**, 0 islands, both from mfe-1@21.2.2 | matches the stated goal exactly |
| patch drift, ragged, R=50 | 140 dl | **80 dl**, 0 islands | |
| major drift, ragged, R=50 | 459 dl | **429 dl**, 16/50 islanded (the genuinely incompatible) | |
| M=145 sweep, R=25 | 381 dl | **145 dl**, 0 islands | |

There is **no safety-vs-downloads trade-off left**: every measured shape is both coherent and cheaper
than today. The 3–6× penalty in §12.2 was an artefact of exact-tag agreement, not of coherence.

### 13.4 Runtime — scales, but only with two precomputations

Prototype (`<scratchpad>/family-probe.spec.ts.keep`), verdicts verified identical between variants:

| shape | naive | with precomputation |
| --- | --- | --- |
| production capture (R=7, M=11) | 0.29 ms | **0.24 ms** |
| R=50, M=80 (patch, ragged) | 262 ms | **4.4 ms** |
| R=50, M=80 (major, ragged) | 159 ms | **3.4 ms** |
| R=25, M=145 | 88 ms | **9.0 ms** |

Both precomputations are **mandatory**, not optimisations:

- **Acceptance table** — `remote → member → Set<accepted tag>`, built once per pool with the memoized
  `isCompatible`. Distinct `(tag|range)` questions stay tiny at any scale (3–14 measured, even at
  R=50/M=145); it is the *call count* that explodes without the table (510k).
- **Direct assignment for single-provider members** (§13.2 step 2) — without it the extension loop
  re-scores every instance every round, which is O(rounds · R² · M) and accounts for the 262 ms.

With both, election is O(R·V) and the gate O(V), landing in the same order as `determine` (0.05–7 ms)
and today's pooling step (0.3–2.2 ms).

### 13.5 Consequences and one open question

- **Host precedence is overridden.** In Case 2 the model elects mfe-a's `22.1.0` over the host's
  `22.0.5` (the host then dedups, and total downloads drop 3 → 2). That contradicts `determine`'s
  absolute host precedence (`determine-shared-externals.ts:130`). Auke's "I don't mind if the final
  shared version is a different version" implies this is intended — **needs explicit confirmation**,
  since it changes a documented rule. Fallback: keep host as a hard constraint and accept Case 2
  islanding mfe-a instead (measured: 3 dl, still coherent).
- **Residual exposure by design.** When a remote draws from two instances (F3), safety rests on
  `requiredVersion` being an honest statement of coupling — the very thing whose looseness caused this
  bug. Election minimising the instance count is therefore load-bearing; a stricter "single instance for
  the whole shared set" mode remains available at the §12.2 download cost.
- §12's exact-tag analysis stands as the reason *not* to compare tags, and §12.1's runtime caveat still
  applies: the healthy path must early-out.

---

## 14. Host absolute + the two-test analysis (test B DROPPED — see §15)

Auke: **"Host has the highest precedence, so higher than pool and it should always win."** Recorded, and
measuring it exposed the last structural point: with the host pinned, **`requiredVersion` alone cannot
keep Case 2 fixed**, because the declared ranges in the crash case and in the safe ragged case are
*identical*.

| | member it self-serves | shared tag it also takes | its declared range | outcome |
| --- | --- | --- | --- | --- |
| Case 2 (crash) | `router@22.1.0` | `core@22.0.5` (host) | `^22.0.0` — accepts | **must island** |
| ragged patch drift (safe) | `only-13@22.0.6` | `pkg-00@22.0.5` | `^22.0.0` — accepts | **must dedup** |

Same declared range, same topology, opposite correct answers. `requiredVersion` cannot discriminate. The
only signal in the data that does is **tag distance**: `22.1.0` vs `22.0.5` crosses a minor line,
`22.0.6` vs `22.0.5` does not. So the model needs *two* acceptance tests, for two different questions:

> **A. "May remote R take its whole family from instance I?"** → **`requiredVersion`** (Auke's rule).
> This is what lets a family dedup down to an older-but-consistent build, and what makes Point 4 work.
>
> **B. "May remote R draw from instances I *and* J?"** → they must agree **within one minor line** on
> every member both ship. Only reachable when no single instance covers R (a sole-provider member, or a
> host pin that does not cover the family). Fails ⇒ R scopes its whole family.

### 14.1 Measured — all four cases fixed, host pinned, still cheaper than today

| fixture | today | final spec |
| --- | --- | --- |
| Case 1 (strict pin) | 3 dl, broken | 3 dl — shared `core+router@22.1.0`, mfe-b islanded |
| **Case 2 (host pins core)** | 3 dl, broken | **3 dl — shared `core@22.0.5` (host wins), mfe-a islanded, `router` scope-only** |
| Case 3 (production capture) | 29 dl, broken | **17 dl** — form-overview islanded, shared set Angular-22 only |
| Point 4 (21.2.2 vs 21.2.3) | 4 dl | **2 dl**, 0 islands, both from mfe-1@21.2.2 |
| patch drift + ragged, R=50 | 140 dl | **80 dl**, 0 islands |
| major drift + ragged, R=50 | 459 dl | **429 dl**, 16/50 islanded |
| M=145 sweep, R=25 | 381 dl | **145 dl**, 0 islands |

Runtime with both precomputations (§13.4): 0.04 ms on the cases, 4.3 ms at R=50/M=80, 13.5 ms at M=145.

**Host pinning is cheap but not free:** Case 2 costs one download more than letting election move the
host (2 dl), and it islands mfe-a rather than re-pointing the host. That is the price of the rule and it
is now the specified behaviour. Note `hostTag` must be seeded *before* election, and members the host
ships are never re-pointed by extension.

### 14.2 Why minimising chosen instances is load-bearing (answer to Auke's Q2)

Not an efficiency preference — it is what carries the safety:

- **A remote drawing on ONE instance is consistent by construction.** That build's members were compiled
  and tested together; nothing about version metadata has to be true for the combination to work.
  `requiredVersion` only decides *whether* the remote may use it at all.
- **A remote drawing on TWO instances is consistent only if the metadata is honest.** Its declared range
  has to genuinely express its coupling — and the root cause of this whole bug (§2) is that it does not:
  Angular emits `^22.0.0` while `router@22.1.0` truly requires `core@22.1.0`.

So every extra instance in the shared set moves a remote from "safe by construction" to "safe if the
range is honest". Test B exists precisely because that trust is misplaced; keeping the instance count low
keeps the number of remotes relying on it low. On the production capture the model picks 3 instances and
2 distinct shared tags (`22.0.6` cdk/material, `22.0.8` core/…), so real portfolios *do* reach the
multi-instance case — B is not hypothetical.

Consequence for the algorithm: instance count is a **scoring term**, not just a tiebreak — prefer a
candidate set that covers the pool with fewer instances even at equal remotes-served.

---

## 15. SPEC — simplified (2026-07-29, Auke's call)

> "The more we're trying to cover, the more complex and fragile the feature becomes. It is acceptable to
> expect the remotes to change to `~22.0.6`; using the host `remoteEntry.json` is a deliberate choice to
> lock certain versions to always be shared, that should remain the nr 1 priority."

**Test B (the minor-line cross-instance guard) is dropped.** Measured justification — it changes nothing
anywhere except Case 2:

| shape | today | spec (host + `requiredVersion` only) | with guard |
| --- | --- | --- | --- |
| Case 1 | 3, broken | 3, fixed | 3 |
| **Case 2** | 3, broken | **3, still broken** ← the only difference | 3, fixed |
| Case 3 (capture) | 29, broken | **17, fixed** | 17 |
| Case 5 (nested) | 5 | **3**, 0 islands | 3 |
| Point 4 | 4 | **2**, 0 islands | 2 |
| patch drift ±ragged, R=25/50 | 90–140 | **30–80**, 0 islands | identical |
| major drift ±ragged, R=25/50 | 239–459 | **209–429**, only the incompatible islanded | identical |
| M=85 / M=145 sweeps | 201 / 381 | **85 / 145**, 0 islands | identical |

Ten scale shapes, byte-identical outcomes. The guard buys exactly one scenario and costs a whole concept,
so it goes.

### 15.1 The rules

1. **Host wins, always** — priority #1, above pooling. Host-declared tags are pinned *before* election
   and never re-pointed by election or extension. Using the host entry to lock a version is a deliberate
   act and the resolver honours it.
2. **Membership**: unchanged (`pool` tag / npm scope → connected components, `pool-graph.ts`).
3. **Election**: choose the family instance maximising **remotes that can dedup entirely onto it**. That
   objective is the only scoring term — "how many remotes can share it" always outranks "how many members
   it contains" (Auke, 2026-07-29). Everything else is a tiebreak, in order: **fewer chosen instances**
   (the safety term, §14.2) → **instance size** (§15.2, resolves nested chains) → host → declaring remote
   → name (reload-stability). Single-provider members are assigned directly, never scored.
4. **Acceptance**: a remote's declared **`requiredVersion`** decides whether it can take the chosen tags.
   One test, no tag-distance concept anywhere.
   **Qualified 2026-07-30 (Auke): `strictVersion: false` accepts anything** — the test is
   `isCompatible(tag, requiredVersion) || !strictVersion`. Rationale: `determine` already reads the flag
   that way. When a version's range rejects the winner, `applyWinner` marks it `scope` **only if some
   remote objected strictly**, otherwise `skip` — so a loose remote is deduped onto an incompatible tag
   today, by its own declaration. Testing `requiredVersion` alone would make pooling *stricter than the
   resolver it defers to*: a remote declaring `^21.0.0` with `strictVersion: false` is deduped onto
   `22.0.8` today but would island its whole family, costing more downloads than the status quo and
   falsifying §13.3's "strictly better than today, everywhere" for any portfolio with loose remotes.
   This does not reintroduce tag distance — it honours a declared tolerance, which is what the flag is.
   No pooling spec exercises a loose remote today (`determine-shared-externals.spec.ts:71,87,173` do),
   so the suite would not have caught it.
5. **All-skip or all-scope** (F2): a remote that cannot take every member it consumes from the chosen
   instances scopes its whole family from its own build.
6. **Residual exposure is a documented authoring rule, not an algorithm.** A remote whose real coupling
   is tighter than its declared range must declare it (`~22.0.6`, not `^22.0.0`). Then `determine` marks
   it `scope` and the existing island gate handles it — which is exactly how Case 1 is already fixed.
   Instead of enforcing, **log at `debug` when a remote ends up drawing from more than one instance**.
   It is *not* a warning (Auke, 2026-07-29): multi-instance draws are the normal case — the production
   capture elects 3 instances and 2 distinct shared tags — and §14 established that the dangerous and the
   benign shape are indistinguishable without a tag-distance concept, which §15 does not have. A warning
   that fires on healthy portfolios and cannot be acted on is noise. **`warn` is reserved for islanding**
   (a remote that scopes its whole family), which is actionable and rare.

### 15.2 Asymmetric pools — Auke's question, confirmed

> "With asymmetric families/pools, wouldn't we want to choose the biggest pool because it guarantees the
> biggest coverage? remote1 = {core, common, material}, remote2 = {core, common} — remote2 will go well
> with remote1, but not particularly remote1 with remote2."

**Correct, and for the reason stated: containment is directional.** The subset remote can be served
entirely by the superset instance; the superset remote cannot be served by the subset instance — it
would have to fetch `material` from elsewhere, i.e. mix instances or island. Measured (Case 5): electing
remote1 gives 3 downloads and zero islands versus today's 5.

But raw size must **not** be the objective — measured on the production capture it elects the Angular-**21**
instance (the biggest, 37 shared entries) and islands three Angular-22 remotes, costing 46 downloads
versus 17. Size and compatibility are different axes.

**"Remotes fully served" already encodes the coverage preference**, because a remote counts as served only
if the instance covers *every* member it consumes — so a superset instance always scores ≥ its subsets,
and Case 5 elects remote1 under this objective. It just cannot be fooled by a big incompatible instance.
Instance size stays as the **tiebreak**, which is what resolves nested chains where several instances
serve the same remote count.

---

## 15.3 Relation to `determine`'s verdicts — unchanged

§15's rules replace the tag-agreement model, **not** determine's verdict vocabulary or the existing island
gate. Two things stay exactly as they are today:

1. **The strict-incompatibility gate remains outermost and runs first.** `islandedRemotes`
   (`pool-shared-externals.ts:13-19`) still islands any remote holding a version determine marked
   `scope`, across the whole family. §15.1 rule 6 depends on this: the authoring rule ("declare
   `~22.0.6`") only works *because* determine then marks the version `scope` and this gate handles it —
   which is precisely how Case 1 is fixed.
2. **Candidate instances are restricted to versions marked `share`/`skip`.** A `scope` version is never
   promoted into an elected instance. This was I3's second clause and it survives the redesign for the
   same reason it existed: promoting a `scope` version cascades scoping and is self-defeating.
   **An islanded remote contributes no instance at all** — not even for members it is the *sole*
   provider of, whose own version is still marked `share`. This is not a detail: it is precisely the
   capture's failure (§1 Case 3), where `form-overview` is correctly islanded on `core` yet keeps
   `animations@21.2.18` globally shared beside `core@22.0.8`. Dropping the whole instance, rather than
   the offending version, is what makes the shared set itself coherent and is what produces the
   measured 17 downloads.

Consequence for the defensive throw at `pool-shared-externals.ts:87-93`: it keys off `islanded.size` under
`strictExternalCompatibility` and its meaning is unaffected, because the set it reads is still built from
`action === 'scope'` only. Per §11.5, an all-scope decision made by §15's own acceptance test never throws.

## 15.4 The per-remote pass iterates to a fixed point

All-skip-or-all-scope is **monotone**: scoping a remote's whole family can remove the last live provider of
a member (§13.2 step 5), which turns that member scope-only and can push another remote from "takes
everything from the chosen instances" to "cannot". So the pass repeats, **re-entered only when the previous
round scoped someone** — normally zero extra rounds, bounded by the remote count. `rebuildMember`'s
existing "winner islanded away ⇒ orphaned `skip` copies self-serve" branch
(`pool-shared-externals.ts:132-136`) already produces the right per-member output for the derived case.

## 15.5 Dynamic init — strictly additive (restates §7 in instance terms)

Confirmed (Auke, 2026-07-29): the dynamic path is **additive only**. The committed import map is immutable,
so election never runs here and no committed version is ever re-pointed — the newly loaded remote is the
only thing that can move.

> The loaded remote may dedup a pooled family member only if it can take **every** member it consumes from
> the **committed** instances, judged by its own declared `requiredVersion`. Otherwise it scopes its whole
> family from its own build.

The committed serving instance of a member is `remotes[0]` of its committed `share` version (the basis, per
PR #62). Because init already applied §15, the committed side is coherent, so in practice this reduces to:
every member it consumes must be committed, and it must take all of them. The existing tag-only /
auto-pooling early-out stays first, and `memberActions.includes('scope')` remains as the outer gate (§15.3).

## 15.6 Case 2 is the accepted price of absolute host priority

Recorded explicitly, since it is the one shape §15 does not fix. Host priority is rule #1, so `core` stays
on the host's tag; `router` has a single provider, so it is served from that remote's instance. The remote's
`^22.0.0` accepts **both** chosen tags, so it dedups `core` from the host instance and takes `router` from
its own — a mixed family, exactly the bug, and neither the acceptance test nor islanding fires.

This is a deliberate trade (Auke, 2026-07-29): overriding the host to repair it would break a stronger and
more useful guarantee — using the host `remoteEntry.json` to lock a version is a deliberate act. The
mitigation is the authoring rule of §15.1 rule 6: a remote whose real coupling is tighter than its declared
range must say so (`~22.0.6`). Then determine marks it `scope` and §15.3's gate islands it.

**Test disposition:** the Case 2 arm of `split-family.repro.spec.ts` is therefore **not** inverted. It stays
as a permanent specification of this limitation, with a docblock naming the authoring rule. Only the Case 1
arm flips to asserting the fix.
