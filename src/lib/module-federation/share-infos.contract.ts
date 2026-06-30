/**
 * The object shapes webpack Module Federation expects for its `shared` config
 * (the input to `init({ shared })` / `createInstance({ shared })`).
 *
 * The type names mirror Module Federation's own (`ShareInfos`, `Shared`,
 * `SharedConfig`), so what `getShared()` returns lines up with the types a
 * consumer already sees on the MF side.
 */

/** The per-package config flags — MF's `SharedConfig`. */
export type SharedConfig = {
  singleton?: boolean;
  requiredVersion: string;
  strictVersion?: boolean;
};

/** A single shared descriptor — MF's `Shared`. */
export type Shared = {
  version: string;
  /**
   * The Module Federation share scope. Omitted for native federation's global
   * scope (MF then uses its `'default'` scope); set to the share-scope name for
   * externals native federation grouped under a custom `shareScope` (or
   * `'strict'`).
   */
  scope?: string;
  get: () => Promise<() => unknown>;
  shareConfig?: SharedConfig;
};

/** The whole `shared` map (package name → descriptors) — MF's `ShareInfos`. */
export type ShareInfos = {
  [packageName: string]: Array<Shared>;
};

export type GetSharedOptions = {
  /**
   * Marks the emitted externals as Module Federation singletons. When omitted,
   * an external is a singleton when native federation resolved exactly one
   * shared version for it (always the case for the global and custom share
   * scopes; the `strict` scope may share several exact versions side by side).
   */
  singleton?: boolean;
  /**
   * When set, the `requiredVersion` is built as `prefix + version` (the v3
   * behaviour). When omitted, the bridge uses the `requiredVersion` negotiated
   * by native federation, falling back to a caret range.
   */
  requiredVersionPrefix?: '^' | '~' | '>' | '>=' | '';
};
