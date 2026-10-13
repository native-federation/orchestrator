import type { AcceptsTag } from './compatibility';
import type { SharedVersion, SharedVersionAction, VersionName } from './version.contract';

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
