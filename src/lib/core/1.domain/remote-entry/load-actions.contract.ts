import type { SharedInfoActions } from './remote-entry.contract';

// Internal to a runtime load: a skip also carries the entrypoints the committed map serves of it.
export type LoadActions = Record<string, SharedInfoActions[string] & { covered?: string[] }>;
