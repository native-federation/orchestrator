import type { ExternalName } from 'lib/core/1.domain';
import type { PooledExternals } from './for-marking-pools-for-reelection.port';

/**
 * The externals this pass re-elected, per shareScope. Determine clears `dirty` before pooling runs,
 * so this is the only signal left of what changed; a scope with nothing re-elected is absent rather
 * than empty.
 */
export type TouchedExternals = ReadonlyMap<string, ReadonlySet<ExternalName>>;

// Omitting `pooled` means no pool is up for re-election: every dirty external is elected here.
export type ForDeterminingSharedExternals = (pooled?: PooledExternals) => Promise<TouchedExternals>;
