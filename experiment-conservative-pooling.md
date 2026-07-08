# Experiment — Conservative pooling: follow the resolver, don't re-elect

> Design exploration, not a committed decision. Companion to `experiment-pooling.md` (the rejected
> vector primitive). Captures a
> different idea: the init pooling step currently **re-resolves** each family from scratch (elect an
> anchor remote, re-run `isCompatible` across every member × remote). Its dynamic-init counterpart
> does the opposite — it **reads the already-decided actions** and only conservatively scopes. This
> asks: can init pooling be as conservative as dynamic pooling?

## The observation

`pool-dynamic-externals` never re-elects. It reads each member's already-committed action
(`share` / `skip` / `scope`) and only flips `share → scope` to enforce coherence on the *new* remote.
It explicitly honours host precedence "by construction" because the versions it follows were already
elected host-first in the init step.

`pool-shared-externals` (init) is the outlier. It ignores the per-external decisions
`determineSharedExternals` just made and re-derives everything: `selectAnchor` runs an O(R²·M)
min-downloads search, `classifyRemote` re-computes `isCompatible` for every member × remote. It is
recomputing compatibility the base resolver already computed one step earlier.

**Thesis: init pooling should read determine's result and reconcile coherence on top of it, not
resolve the family a second time.**

## What determine already gives us

Per external, per scope, `determineSharedExternals` produces a `SharedExternal` whose `versions`
already encode a full per-remote classification:

| determine's output      | meaning                                                        |
| ----------------------- | ------------------------------------------------------------- |
| the `share` version     | the elected winner (host-first, then latest/min per config)   |
| `skip` remotes          | compatible with the winner — they fall through to it          |
| `scope` remotes         | strict-incompatible — they serve their own copy               |

So determine has **already** told us, per member: the shared version and which remotes follow it
versus which are incompatible — applying host precedence and `latestSharedExternal` for free. Pooling
re-derives all of this. The only thing determine does **not** give us is the pooling-specific
constraint: *coherence across members*.

## The core tension — why we can't blindly follow

Determine elects each member's shared version **independently**. So its per-member winners may come
from **different remotes**:

```
member core: shared version 15.2.0  ← provided by remote A
member cdk : shared version 15.2.1  ← provided by remote B   (A never shipped cdk@15.2.1)
```

A remote told to "follow both winners" would run `{core@15.2.0, cdk@15.2.1}` — a combination **no
remote ever built**. That is precisely the incoherence pooling exists to prevent, and the reason the
orchestrator cannot synthesize vectors (it has no cross-member coupling metadata — see
`experiment-pooling.md`). So "follow determine" cannot be blind: the shared build must still trace to
a **single coherent source**.

## The conservative model — a fast path with a coherence test

The key realisation: in the common case, determine's per-member winners are already coherent, and the
coherent anchor can be **read off determine's output for free** — no search:

1. **Coherence test.** For each member take determine's `share` (+ host) providers. Ask: is there a
   remote present in the share-set of **every member it provides**? (Partial portfolios allowed — a
   remote need only be coherent across the members it ships.)
2. **Coherent (common) case.** Such a remote exists ⇒ it *is* the anchor, witnessed by determine.
   Lockstep families land here: one remote shipped the whole family at 15.2.0 and won every member's
   election. Pooling emits the same shared build it would have elected — **without** the O(R²) search.
   Near no-op.
3. **Incoherent case.** No common provider — determine's winners span remotes with no witnessed
   combination. This is the only case that needs real reconciliation. Two candidate policies (the
   decision this doc must settle):
   - **(a) Fall back to the current election** (`selectAnchor`, which already groups remotes into
     equivalence classes). **Behaviour-preserving**: identical output, we just skipped the search when
     it was provably unnecessary.
   - **(b) Conservatively scope the offenders** — keep coherent members shared, scope the members
     that break coherence. **Simpler and cheaper**, but a **policy change**: more runtime downloads
     than the download-minimizing anchor would have produced.

## What changes observably

- **Coherent pools: nothing.** The free anchor is the same remote the min-downloads election would
  pick (full-follow ⇒ minimal cost); with the same name-earliest tiebreak, output is identical.
- **Incoherent pools:** unchanged under policy (a); **more scoping / more downloads** under policy
  (b). Policy (b) trades runtime download cost for resolution simplicity — acceptable only if
  incoherent pools are rare (they are: they mean genuine cross-remote drift) and safety is preferred
  over optimal sharing there.

## Benefits

- **Kills the election cost in the common case.** The O(k²·M) election runs only on
  genuinely-incoherent pools; lockstep families skip it entirely. This is a bigger lever than the
  already-shipped equivalence-class grouping, and it **demotes** that grouping: if the election rarely
  runs, collapsing R→k inside it matters far less.
- **Less duplicated logic.** Host precedence, `latestSharedExternal`, and per-remote compatibility are
  computed once in determine and *read*, not recomputed. Pooling shrinks toward "reconcile coherence,"
  matching the dynamic step's shape — the two pooling steps converge conceptually.
- **Inherits host-first for free**, exactly like the dynamic step already claims.

## Drawbacks & risks

- **Policy (b) erodes pooling's own goal.** Pooling exists to maximise coherent *sharing* (fewer
  downloads); conservative-scoping does the opposite on incoherent pools. If we choose (b), we must be
  honest it can increase downloads versus today. Policy (a) avoids this but keeps the election on the
  slow path.
- **The coherence test needs a precise, sound definition** — especially for **partial** portfolios
  (a remote coherent across the members it ships, but not covering all). Getting "common provider
  across a member's own set" wrong either fragments coherent families or (worse) blesses an
  incoherent combination. This is the crux to nail on paper, like the equivalence-class fingerprint was.
- **Determinism.** The free anchor must be chosen deterministically (name-earliest among common
  providers) to match the election's tiebreak under policy (a), and to be reload-stable in general.
- **`strictExternalCompatibility`.** The forced-scope error path must still fire when a family cannot
  cohere under strict mode — same as today, just detected from determine's actions.
- **Reads determine's mutated output.** Pooling now depends on the exact `share/skip/scope` shape
  `determineSharedExternals` emits. That couples the two steps more tightly; a change to determine's
  action semantics could silently shift pooling. (Today the coupling is looser — pooling only reads
  raw versions.)

## Open questions

- **Incoherent-case policy: (a) fall back to election, or (b) conservative-scope?** The whole
  behaviour-preserving-vs-simpler tradeoff lives here. Lean: start with **(a)** (safe, keeps output
  identical, still gets the common-case speedup), consider (b) only if profiling says the slow path
  matters and downloads-on-incoherence is acceptable.
- What exactly is the coherence test for partial portfolios — "a remote in the share-set of every
  member it provides," or something stronger about family-wide coverage?
- Does reading determine's `share/skip/scope` actions (rather than re-deriving from raw versions)
  create any gap versus the current pooling result on coherent pools? (Prove the fast path is
  output-identical.)
- Is the tighter coupling to determine's action semantics worth documenting as a contract between the
  two steps, so a future change to one doesn't silently break the other?

---

## Verified against code (2026-07-08)

Traced `process-remote-entries` → `determine-shared-externals` → `pool-shared-externals` (init) vs
`pool-dynamic-externals`, plus `pool-anchor`, `pool-classify`, `pool.util`, and the domain types.
This section records what held up, what didn't, and how the real-world constraint (independent repos
on independent Renovate tempos) reshapes the recommendation.

### What the code confirms

- **Init pooling really re-resolves.** `pool-shared-externals.ts:112` calls `selectAnchor` (the
  min-downloads search in `pool-anchor.ts:97-107`) and `:121` calls `classifyPool` → `classifyRemote`,
  re-running `versionCheck.isCompatible` per remote per member (`pool-classify.ts:39`) — *after*
  `determine-shared-externals` already assigned every version a `share`/`skip`/`scope` action.
- **The dynamic step really is conservative.** `pool-dynamic-externals.ts:53-64` reads
  `actions[name].action` and only flips `share → scope`. No `isCompatible`, no election, O(members)/pool.
- **The core tension is real.** `determine-shared-externals.ts:36-44` resolves each external
  independently — nothing couples members, so per-member winners can come from different remotes.
- **Equivalence-class grouping is ALREADY shipped.** `groupRemotesByProfile` is live in `selectAnchor`
  and `classifyPool`, so the election is already O(k²·M), not O(R²·M) (commit 76aad97 "Performance
  improvements").

### Correction: determine encodes the winning *tag*, not a per-remote classification

The doc claims determine hands us a per-remote follow/scope verdict to read directly. Not quite.
Determine records, per member: the winning **tag** (`versions.find(v => v.action==='share').tag`) and
its **provider set** (that version's `.remotes`), plus a skip/scope verdict per *version* — but
computed only from `remotes[0]` (`determine-shared-externals.ts:101`), whereas pooling classifies
*every* remote's meta. So it's a per-tag verdict, not the per-remote classification pooling needs. The
verdict is directly reusable **only when the pool anchor's tag equals determine's winning tag** — i.e.
the coherent case below.

### The flaw: "coherent across the members it provides" is unsound

The doc's partial-portfolio test (§ core model, step 1-2: *a remote in the share-set of every member
it provides is the anchor, name-earliest*) is **not** output-identical to `selectAnchor`.
Counterexample (no host, `latestSharedExternal` off):

```
members: m1, m2
remote P: m1@1 (winning tag)          → passes test across {m1}
remote Q: m1@1, m2@1 (both winning)   → passes test across {m1,m2}
name order: P < Q
```

- Doc's fast path → name-earliest = **P** (partial) → m2 orphaned/scoped-only
  (`rebuildMember`, `pool-shared-externals.ts:199-207`) → every remote downloads its own m2.
- `selectAnchor` → `cost(P)=1+usedCount(Q)=3`, `cost(Q)=2` → elects **Q**, m2 shared.

The partial test fragments a family the current code pools — exactly the drawback at line 104-107,
confirmed non-hypothetical.

### The sound version: full-witness lockstep

Restrict "coherent" to **one remote provides the winning tag for *every* member of the pool** (full
witness, not partial). Then:

- All full-witness remotes share an identical fingerprint → collapse to one class in
  `groupRemotesByProfile` → anchor unique up to name tiebreak.
- Anchor tag = determine's winning tag for every member ⇒ each other remote's pool classification
  collapses to determine's own verdict (determine `skip`→`follow`, determine `scope`→`scope-incompat`;
  `pool-classify.ts:39-41` and `determine-shared-externals.ts:101-114` apply the same rule against the
  same tag). **No coverage-forced case** — the anchor covers all members.
- ⇒ pool build = determine's result reinterpreted, **zero `isCompatible` calls**, pure set arithmetic
  on the share versions' `.remotes`.

This is the provable fast path. Use the **full-witness** test, not the partial one.

### The default config is the expensive branch — and why that's the argument *for* this

`default.profile.ts:4` sets `latestSharedExternal: false`, and a `host` version exists only when the
consumer configured `config.hostRemoteEntry` *and* that host declares the pooled dep
(`get-remote-entries.ts:150-151`). So **no-host + latest-off is the common/default config**, which is
precisely `selectAnchor`'s min-downloads branch (`pool-anchor.ts:97-107`) — the O(k²·M) `isCompatible`
one.

This does **not** undermine the fast path: the fast path replaces `selectAnchor` *entirely*, so which
internal branch it would have taken is irrelevant. Fast-vs-slow is decided by **witness existence**,
not host/latest. And the full-witness anchor is provably the min-downloads winner even with no host:

```
cost(witness W, covers all M) = M + Σ(strict-incompat remotes)   // no coverage-forced: W covers all
cost(partial G, covers m<M)   = m + usedCount(W) + …  ≥ m + M  >  cost(W)
```

because any partial anchor coverage-forces W itself (W uses members G lacks), pulling W's whole
`usedCount` into G's cost. So the witness wins the election it is skipping. The default config being
the expensive branch is the reason to do this, not a reason against.

### The decisive constraint: independent repos, independent Renovate tempos

Remotes are developed in separate repositories; dependency bumps land via Renovate at different tempos,
so versions differ **substantially** across remotes. This is the realistic model and it reshapes the
distribution of coherent vs torn pools — but it argues *for* the conservative approach.

- **Within-remote coherence survives.** Renovate bumps a coupled family together in one repo (Angular
  packages are peer-locked and grouped), so remote A ships the whole family at 15.2, B at 16.1, C at
  15.0 — each internally consistent. That within-remote consistency is the only property the witness
  test needs; independent repos don't break it. Cross-remote *alignment* is what dies.
- **The witness often survives cross-remote drift.** determine's per-member election sees the same
  remotes with the same relative version structure for every member (each remote ships them as one
  set), so identically-structured inputs → same min-extra-downloads pick → winners land on **one
  remote's set** → full witness → fast path. Drift across remotes doesn't defeat the witness;
  **ragged portfolios** do (A ships {core,router}, X ships {material,cdk}, winners split with no
  overlap). Independent repos + partial dep usage make ragged portfolios real, so witness-less pools
  occur more than pure lockstep suggests.
- **The election is near-worthless exactly where drift is substantial.** Walk `downloadCost` at the
  extremes:
  - *Substantial drift* (A@15, B@16, C@17, mutually strict-incompatible): every non-anchor is
    `scope-incompat` under any anchor ⇒ `cost = total members across all remotes`, **identical for
    every candidate.** The O(k²·M) election computes an indifferent answer; conservative-scope gives
    the same download count for O(members).
  - *Near-lockstep*: witness exists → fast path, free.
  - *Moderate ("middle-zone") drift*: partial compatibility where the anchor choice changes who
    follows vs scopes — **the only regime where the election earns its cost.**

  Substantial independent drift pushes pools *out* of the middle zone into the forced-scope regime,
  where the cheap path matches the expensive one. The election is most expensive and least valuable in
  the same place.

### Revised recommendation

- **Fast path (full-witness) — keep regardless.** Fires whenever determine's winners align to one
  remote. Free, output-identical, config-independent.
- **Witness-less pools — choose by how *clustered* the drift is:**
  - **Policy (b) conservative-scope** (read determine's actions, scope torn members — the
    `pool-dynamic-externals.ts:56-63` logic) when drift is genuinely substantial/spread (this repo's
    situation): the election is near-indifferent there, so (b) is nearly free *and* nearly optimal, and
    it makes init structurally identical to the already-trusted dynamic step. Loses optimality only in
    the thin middle zone.
    - **Middle-zone caveat:** with *clustered* drift (many teams on last LTS, a few early adopters on
      next), (b) can scope more than the min-downloads anchor would — real sharing left on the table.
  - **Policy (a) fall back to `selectAnchor`** only if you observe clustered-version pools where
    blessing the right cluster meaningfully cuts downloads. Keeps the expensive election, but only on
    the cold, genuinely-torn minority.

  Lean for this codebase (independent repos, independent tempos): **fast-path witness + policy (b)** —
  the expensive recalculation buys almost nothing in the drift regime we actually have.

### Corrected open questions

- The coherence test is **full-witness** ("one remote on the winning tag of *every* member"), not the
  doc's partial-portfolio form — the latter orphans families the election shares (P/Q counterexample).
- Fast path is output-identical on full-witness pools (cost proof above); the partial generalization is
  not, so drop it.
- Policy (b)'s only real cost is middle-zone (clustered-drift) pools; quantify how many real pools land
  there before committing (b) over (a) for the witness-less case.
