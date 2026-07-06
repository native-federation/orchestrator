import type { RemoteName } from 'lib/core/1.domain';
import type { ForVersionChecking } from '../../driving-ports/for-version-checking.port';
import { classifyRemote } from './pool-classify';
import type { PoolAnchor, PoolMember } from './pool.types';
import { remotesInPool, versionForRemote } from './pool.util';

type AnchorConfig = {
  versionCheck: ForVersionChecking;
  latestSharedExternal: boolean;
};

/** Pick the element minimizing `compare`, keeping the earlier element on ties. */
function pickBest(
  candidates: RemoteName[],
  compare: (a: RemoteName, b: RemoteName) => number
): RemoteName {
  return candidates.reduce((best, c) => (compare(c, best) < 0 ? c : best));
}

/**
 * Choose the anchor remote for a pool: the single remote that serves *every* member.
 *
 * Precedence (mirrors determine-shared-externals — a waterfall of selectors):
 *  1. host       — a candidate whose provided versions are all host versions;
 *  2. latest      — when `latestSharedExternal`, the candidate providing the newest versions;
 *  3. min-scoped  — otherwise, the candidate forcing the fewest other remotes to scope;
 *  4. remote-name — deterministic tiebreak within each selector (independent of `cached`).
 *
 * Returns undefined when no single remote provides every member.
 */
export function selectAnchor(
  members: PoolMember[],
  { versionCheck, latestSharedExternal }: AnchorConfig
): PoolAnchor | undefined {
  if (members.length === 0) return undefined;

  const allRemotes = remotesInPool(members);
  // Candidate = a remote present in *every* member; name-sorted so ties resolve by name.
  const candidates = allRemotes
    .filter(remote => members.every(m => !!versionForRemote(m, remote)))
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) return undefined;

  const anchorFor = (remote: RemoteName): PoolAnchor => ({
    anchorRemote: remote,
    tagPerMember: Object.fromEntries(members.map(m => [m.name, versionForRemote(m, remote)!.tag])),
  });

  // 1) host
  const host = candidates.find(remote => members.every(m => versionForRemote(m, remote)!.host));
  if (host) return anchorFor(host);

  // 2) latest: prefer the candidate providing the newest version for the most members.
  if (latestSharedExternal) {
    const newestTag: Record<string, string> = {};
    for (const m of members) {
      let best: string | undefined;
      for (const c of candidates) {
        const tag = versionForRemote(m, c)!.tag;
        if (best === undefined || versionCheck.compare(tag, best) > 0) best = tag;
      }
      newestTag[m.name] = best!;
    }
    const latestScore = (remote: RemoteName) =>
      members.filter(m => versionForRemote(m, remote)!.tag === newestTag[m.name]).length;
    return anchorFor(pickBest(candidates, (a, b) => latestScore(b) - latestScore(a)));
  }

  // 3) min-scoped: fewest other remotes forced to scope by this anchor.
  const scopedCount = (remote: RemoteName) =>
    allRemotes.filter(
      r => r !== remote && classifyRemote(r, members, anchorFor(remote), versionCheck) === 'scope'
    ).length;
  return anchorFor(pickBest(candidates, (a, b) => scopedCount(a) - scopedCount(b)));
}
