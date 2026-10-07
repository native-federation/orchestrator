import type { ExternalName } from 'lib/core/1.domain';

// Per shareScope, the members of every pool up for re-election, which `determine` leaves to pooling.
export type PooledExternals = ReadonlyMap<string, ReadonlySet<ExternalName>>;

// Marks a whole pool dirty when any member is, so pooling never reads a verdict left over from an earlier
// portfolio. Mutates the stored externals only; it writes nothing.
export type ForMarkingPoolsForReelection = () => Promise<PooledExternals>;
