import type { RemoteName } from 'lib/core/1.domain';
import type { ForVersionChecking } from '../../driving-ports/for-version-checking.port';
import type { PoolAnchor, PoolMember, RemoteClassification } from './pool.types';
import { versionForRemote } from './pool.util';

/**
 * Classify a remote for a whole pool: FOLLOW (all members resolve from the anchor) or
 * SCOPE (all members served from this remote's own build). All-or-nothing — a single
 * strict incompatibility with the anchor tag on *any* member scopes the entire family,
 * even for members that are individually compatible.
 *
 * A non-strict incompatibility tolerates the anchor (FOLLOW), matching
 * determine-shared-externals. Ignores `cached` for determinism across reloads.
 */
export function classifyRemote(
  remoteName: RemoteName,
  members: PoolMember[],
  anchor: PoolAnchor,
  versionCheck: ForVersionChecking
): RemoteClassification {
  for (const member of members) {
    const anchorTag = anchor.tagPerMember[member.name];
    // Anchor does not cover this member -> it can never safely follow.
    if (!anchorTag) return 'scope';

    const version = versionForRemote(member, remoteName);
    if (!version) continue;

    const meta = version.remotes.find(r => r.name === remoteName)!;
    const incompatible = !versionCheck.isCompatible(anchorTag, meta.requiredVersion);
    if (incompatible && meta.strictVersion) return 'scope';
  }
  return 'follow';
}
