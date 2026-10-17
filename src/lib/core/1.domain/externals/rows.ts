import type { RemoteName } from '../remote/remote-info.contract';
import type { AcceptsTag } from './compatibility';
import type {
  SharedVersion,
  SharedVersionAction,
  SharedVersionMeta,
  VersionName,
} from './version.contract';

// Newest tag first, as `write()` orders a record. Leaves a tag's rows in their order (`sort` is stable).
export const byTag =
  (compare: (a: VersionName, b: VersionName) => number) =>
  (a: SharedVersion, b: SharedVersion): number =>
    compare(b.tag, a.tag);

export const rowAt = (
  versions: readonly SharedVersion[],
  tag: VersionName,
  action: SharedVersionAction
): SharedVersion | undefined => versions.find(v => v.tag === tag && v.action === action);

// One row per (tag, action): the first row of each absorbs the copies of the later ones, in place. `lead` is
// that first row wherever it stands, so its copies stay in front.
export function mergeRows(versions: SharedVersion[], lead?: SharedVersion): SharedVersion[] {
  const merged = new Map<string, SharedVersion>();
  if (lead) merged.set(`${lead.tag}|${lead.action}`, lead);
  return versions.filter(v => {
    const key = `${v.tag}|${v.action}`;
    const first = merged.get(key);
    if (first === v) return true;
    if (!first) {
      merged.set(key, v);
      return true;
    }
    first.remotes.push(...v.remotes);
    return false;
  });
}

// `redirectRow` and `scopeRemote` can leave a `scope` row beside a shareable one at the same tag.
export function findVersionForTag(
  versions: SharedVersion[],
  tag: string
): SharedVersion | undefined {
  let scoped: SharedVersion | undefined;
  for (const version of versions) {
    if (version.tag !== tag) continue;
    if (version.action !== 'scope') return version;
    scoped ??= version;
  }
  return scoped;
}

// Points a row at `tag`: its copies skip to it, and only the strict ones that reject it keep their own build,
// split off into a `scope` row beside it. Returns the rows that replace `version`, in order; mutates it in place.
export function redirectRow(
  version: SharedVersion,
  tag: VersionName,
  acceptsTag: AcceptsTag
): SharedVersion[] {
  const objecting = new Set(
    version.remotes.filter(r => r.strictVersion && !acceptsTag(tag, version.tag, r.requiredVersion))
  );

  if (objecting.size === 0) {
    version.action = 'skip';
    return [version];
  }
  if (objecting.size === version.remotes.length) {
    version.action = 'scope';
    return [version];
  }

  version.remotes = version.remotes.filter(r => !objecting.has(r));
  version.action = 'skip';
  // Beside its source rather than appended: the record stays newest-first, which `write()`
  // guarantees and a later election reads as "the latest".
  return [version, { tag: version.tag, host: false, action: 'scope', remotes: [...objecting] }];
}

// Moves each of `remotes`' copies out of every `share` and `skip` row into the `scope` row of their tag; a new scope
// row goes right after its source, so the record stays newest-first. In one pass, yet ordered as if each remote
// moved in turn: copies by remote then by row, a host's in front. Mutates the source rows, returns the new list.
export function scopeRemotes(
  versions: SharedVersion[],
  remotes: readonly RemoteName[]
): SharedVersion[] {
  if (remotes.length === 0) return versions;
  const turn = new Map(remotes.map((remote, i) => [remote, i]));
  const moves = new Map<VersionName, Move[]>();
  versions.forEach((source, at) => {
    if (source.action === 'scope') return;
    const byTurn = new Map<number, SharedVersionMeta[]>();
    for (const copy of source.remotes) {
      const i = turn.get(copy.name);
      if (i === undefined) continue;
      const copies = byTurn.get(i);
      if (copies) copies.push(copy);
      else byTurn.set(i, [copy]);
    }
    if (byTurn.size === 0) return;
    // The host leads its row and a later election finds the host's tag by the flag, so both move with it.
    const hostTurn = source.host ? turn.get(source.remotes[0]!.name) : undefined;
    source.remotes = source.remotes.filter(r => !turn.has(r.name));
    if (hostTurn !== undefined) source.host = false;
    const tagMoves = moves.get(source.tag) ?? [];
    for (const [i, copies] of byTurn)
      tagMoves.push({ turn: i, at, source, copies, host: i === hostTurn });
    moves.set(source.tag, tagMoves);
  });

  const rows = [...versions];
  for (const [tag, tagMoves] of moves) {
    tagMoves.sort((a, b) => a.turn - b.turn || a.at - b.at);
    let scoped = rowAt(rows, tag, 'scope');
    if (!scoped) {
      scoped = { tag, host: false, action: 'scope', remotes: [] };
      rows.splice(rows.indexOf(tagMoves[0]!.source) + 1, 0, scoped);
    }
    for (const { copies, host } of tagMoves)
      if (host) {
        scoped.host = true;
        scoped.remotes.unshift(...copies);
      } else scoped.remotes.push(...copies);
  }
  return rows.filter(v => v.remotes.length > 0);
}

type Move = {
  turn: number;
  at: number;
  source: SharedVersion;
  copies: SharedVersionMeta[];
  host: boolean;
};
