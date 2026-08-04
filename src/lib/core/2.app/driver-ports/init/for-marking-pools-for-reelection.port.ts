/**
 * Marks every member of a pool dirty when any one of them is, so `determine` re-elects the pool as a unit
 * and pooling never reads a verdict left over from an earlier portfolio. Mutates the stored externals only;
 * it writes nothing.
 */
export type ForMarkingPoolsForReelection = () => Promise<void>;
