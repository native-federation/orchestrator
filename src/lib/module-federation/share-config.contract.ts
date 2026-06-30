/**
 * The object shape webpack Module Federation expects for its `shared` config
 * (the input to `init({ shared })` / `createInstance({ shared })`).
 *
 * These types mirror what `@softarc/native-federation-runtime@3.x` exposed from
 * `getShared()`, so the orchestrator's bridge stays a drop-in for that API.
 */
export type ShareObject = {
  version: string;
  /**
   * The Module Federation share scope. Omitted for native federation's global
   * scope (MF then uses its `'default'` scope); set to the share-scope name for
   * externals native federation grouped under a custom `shareScope` (or
   * `'strict'`).
   */
  scope?: string;
  get: () => Promise<() => unknown>;
  shareConfig?: {
    singleton?: boolean;
    requiredVersion: string;
    strictVersion?: boolean;
  };
};

export type ShareConfig = {
  [packageName: string]: Array<ShareObject>;
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
