import type { SharedVersion, SharedVersionAction, VersionName } from './version.contract';

// Newest tag first, as `commit()` orders a record. Leaves a tag's rows in their order (`sort` is stable).
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

// Coverage enforcement can leave a `scope` version beside a shareable one at the same tag.
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
