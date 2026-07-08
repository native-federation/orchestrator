# Plan — Conservative init pooling (single path)

> Implementation for the design settled in `experiment-conservative-pooling.md` § "Verified against
> code". The pooling feature is **not shipped**, so there is no behaviour to preserve and no migration
> to stage: we replace init pooling's per-family **re-election** (`selectAnchor` + `classifyPool`, the
> O(k²·M) `isCompatible` search) outright with a single cheap resolve that **reads
> `determine-shared-externals`' output** instead of recomputing it — and delete the old election code.
>
> Scope: `src/lib/core/2.app/steps/pooling/pool-shared-externals.ts` and its helpers. The dynamic step,
> `determine`, and `rebuildMember` are untouched.

## The one rule

Per pool, per scope:

```
anchor    = the remote on the most members' winning tags (name tiebreak)
classify  = read determine's skip/scope actions (no isCompatible)
rebuild   = unchanged
```

No fast-path/slow-path branching, no download-minimizing search, no config flag. A full "witness" (a
remote on the winning tag of *every* member) is just the case where the anchor's coverage is maximal —
the same rule picks it, so it needs no special path.

## Why this is cheap

`classifyRemote` today calls `versionCheck.isCompatible(anchorTag, meta.requiredVersion)`
(`pool-classify.ts:39`). But the anchor only ever tags a member at that member's **winning** tag, and
`determine` *already* computed compatibility against the winner and stored it as the version's `action`
(`determine-shared-externals.ts:101-114`): `skip` ⇒ compatible ⇒ FOLLOW, `scope` ⇒ strict-incompatible
⇒ SCOPE. So we read the verdict instead of recomputing it — zero `isCompatible` calls.

> Accepted divergence (`remotes[0]` gap): determine's per-version action is computed from `v.remotes[0]`
> only, so it may not reflect a non-first remote's own `requiredVersion`. Reusing it is *conservative by
> construction* — we trust determine's per-tag verdict.

## New helpers

### `poolWinners` — read determine's per-member result

```ts
type PoolWinner = { member: PoolMember; tag: string; providers: Set<RemoteName> };

function poolWinners(members: PoolMember[]): PoolWinner[] {
  return members.map(member => {
    const share = member.external.versions.find(v => v.action === 'share');
    return {
      member,
      tag: share?.tag ?? '',                       // '' only if determine left it unresolved (defensive)
      providers: new Set((share?.remotes ?? []).map(r => r.name)),
    };
  });
}
```

Members always carry a `share` version here: pooled externals live in non-strict scopes, are marked
`dirty` on insert (`process-remote-entries.ts:57`) and cleaned by determine — so `share` is present.
The `?? ''` is defensive only.

### `selectCoverageAnchor` — the anchor, O(R·M), no `isCompatible`

```ts
function selectCoverageAnchor(winners: PoolWinner[]): PoolAnchor | undefined {
  const coverage = new Map<RemoteName, number>();
  for (const w of winners)
    for (const r of w.providers) coverage.set(r, (coverage.get(r) ?? 0) + 1);
  if (coverage.size === 0) return undefined;

  // Most members covered wins; name-earliest breaks ties (deterministic, reload-stable).
  const anchorRemote = [...coverage.keys()].sort(
    (a, b) => (coverage.get(b)! - coverage.get(a)!) || a.localeCompare(b)
  )[0]!;

  // Partial anchor: tag only the members it provides at the winning tag. Members it does not cover
  // fall to scoped-only (orphan) via rebuildMember's existing `!anchorTag` branch. When one remote
  // covers every member (the "witness" case), tagPerMember is complete and this reduces to it.
  return {
    anchorRemote,
    tagPerMember: Object.fromEntries(
      winners.filter(w => w.providers.has(anchorRemote)).map(w => [w.member.name, w.tag])
    ),
  };
}
```

### `classifyPoolConservative` — read determine's actions, not `isCompatible`

Drop-in replacement for `classifyPool`. Same all-or-nothing per-remote verdict, same
`scope-incompat > scope-coverage > follow` precedence (`pool-classify.ts`), but sourced from determine:

```ts
function classifyPoolConservative(
  members: PoolMember[],
  anchor: PoolAnchor
): Map<RemoteName, RemoteClassification> {
  const cls = new Map<RemoteName, RemoteClassification>();

  for (const remote of remotesInPool(members)) {
    let coverageForced = false;
    let verdict: RemoteClassification = 'follow';

    for (const member of members) {
      const v = versionForRemote(member, remote);
      if (!v) continue;                               // remote doesn't use this member

      const anchorTag = anchor.tagPerMember[member.name];
      if (!anchorTag) { coverageForced = true; continue; }   // anchor has no build for this member
      if (v.tag === anchorTag) continue;              // same tag as anchor -> compatible by construction

      // Different tag: anchorTag == member's winning tag, so determine already classified this
      // version relative to the winner. scope -> strict-incompatible (dominant, whole family).
      if (v.action === 'scope') { verdict = 'scope-incompat'; break; }
      // action 'skip' (compatible, incl. non-strict-incompatible tolerated by determine) -> follow.
    }

    cls.set(remote, verdict === 'scope-incompat' ? 'scope-incompat'
                   : coverageForced ? 'scope-coverage' : 'follow');
  }

  cls.set(anchor.anchorRemote, 'follow');
  return cls;
}
```

Semantics match `classifyRemote` exactly, with determine's stored verdict standing in for the live
`isCompatible` call — valid because every anchor tag equals that member's winning tag. No `isCompatible`
means O(R·M) map lookups; equivalence-class grouping is no longer needed for speed.

## Rewritten `poolFamily`

```ts
function poolFamily(poolName: PoolName, members: PoolMember[], scope: string): void {
  if (members.length < 2) return;
  const allRemotes = remotesInPool(members);
  if (allRemotes.length < 2) return;

  const anchor = selectCoverageAnchor(poolWinners(members));
  if (!anchor) return;                                 // defensive: real pool always yields one

  const classification = classifyPoolConservative(members, anchor);

  const forcedScope = allRemotes.some(r => classification.get(r) !== 'follow');
  if (forcedScope && config.strict.strictExternalCompatibility) {
    config.log.error(
      3,
      `[${scope}][pool:${poolName}] Pool members are not all compatible with anchor '${anchor.anchorRemote}'.`
    );
    throw new NFError(`Could not pool '${poolName}' in scope ${scope}.`);
  }

  for (const member of members) {
    const rebuilt = rebuildMember(member, anchor, classification);   // UNCHANGED
    warnIfScopedOnly(poolName, member.name, rebuilt, scope);         // UNCHANGED
    ports.sharedExternalsRepo.addOrUpdate(member.name, rebuilt, scope);
  }
}
```

## What stays identical

- `rebuildMember`, `warnIfScopedOnly`, the strict-mode throw, and the `<2 members / <2 remotes` guards
  — byte-for-byte. The `PoolAnchor` shape (`anchorRemote`, `tagPerMember`) is unchanged, so
  `rebuildMember`'s orphan/scope/skip logic (`pool-shared-externals.ts:187-258`) works as-is, including
  the partial-anchor orphan branch for members the coverage anchor leaves untagged.

## What gets deleted

- `pool-anchor.ts` (`selectAnchor`, the min-downloads election) and `pool-anchor.spec.ts`,
  `pool-anchor.equivalence.spec.ts`.
- `pool-classify.ts` (`classifyRemote`) and `pool-classify.spec.ts`.
- `versionCheck` from this step's port dependency (`createPoolSharedExternals`'s `ports` pick) — pooling
  no longer checks compatibility.
- `groupRemotesByProfile` / `RemoteProfileClass` in `pool.util.ts` if nothing else uses them after the
  above (verify with a usage grep before removing; `remotesInPool`, `versionForRemote`, `usedCount`
  stay).

## Behaviour notes

- **Aligned pools** (a remote covers every member — the common case under coupled Renovate bumps): the
  coverage anchor is that remote; output matches what the deleted election produced, far cheaper.
- **Torn pools** (ragged/drifted portfolios, no full-coverage remote): coverage anchor shares what it
  covers, orphaned members scope. May scope more than a download-minimizing search would on the narrow
  "clustered middle-zone" case — accepted; re-add a targeted optimization later only if profiling shows
  a real pool hurting (YAGNI).
- **`remotes[0]` reuse:** verdict follows determine's per-tag action rather than a per-remote
  `isCompatible`; diverges only when remotes sharing a tag declare different `requiredVersion`s — rare,
  and conservative.

## Tests

Replace the deleted specs; the pooling behaviour specs need re-baselining to the coverage anchor:

- `pool-shared-externals.spec.ts`, `pooling.integration.spec.ts`: re-baseline expectations to the
  coverage anchor + conservative classification.
- Add: (1) full-coverage pool ⇒ that remote anchors, correct share/skip, and **no
  `versionCheck.isCompatible` call** (spy) — proves the cheap path; (2) ragged-portfolio torn pool ⇒
  max-coverage anchor + expected orphan scoping; (3) the P/Q case from the experiment doc ⇒ Q anchored,
  m2 shared (guards against the unsound partial-coverage reading); (4) strict mode ⇒ throws on
  cross-member coverage-forced scope.
- Remove `pool-anchor.*.spec.ts` and `pool-classify.spec.ts` with their sources.

## Steps

1. Add `poolWinners`, `selectCoverageAnchor`, `classifyPoolConservative`; rewrite `poolFamily` to use
   them.
2. Delete `pool-anchor.ts`, `pool-classify.ts`, their specs; drop `versionCheck` from the port; prune
   now-unused `pool.util.ts` exports.
3. Re-baseline pooling specs and add the four specs above.
4. Run the pooling suite; confirm no `isCompatible` usage remains in the pooling step.
