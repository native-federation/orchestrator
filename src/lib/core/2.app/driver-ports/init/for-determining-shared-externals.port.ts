import type { ExternalName } from 'lib/core/1.domain';

/**
 * The externals this pass re-elected, per shareScope. Determine clears `dirty` before pooling runs,
 * so this is the only signal left of what changed; a scope with nothing re-elected is absent rather
 * than empty.
 */
export type TouchedExternals = ReadonlyMap<string, ReadonlySet<ExternalName>>;

export type ForDeterminingSharedExternals = () => Promise<TouchedExternals>;
