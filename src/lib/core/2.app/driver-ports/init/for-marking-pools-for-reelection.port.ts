// Marks a whole pool dirty when any member is, so pooling never reads a verdict left over from an earlier
// portfolio. Mutates the stored externals only; it writes nothing.
export type ForMarkingPoolsForReelection = () => Promise<void>;
