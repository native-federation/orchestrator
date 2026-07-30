import type { TouchedExternals } from './for-determining-shared-externals.port';

/** Omitting `touched` means "no signal": every pool is processed, as before W2. */
export type ForPoolingSharedExternals = (touched?: TouchedExternals) => Promise<void>;
