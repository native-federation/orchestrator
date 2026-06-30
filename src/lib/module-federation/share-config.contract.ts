/**
 * The object shape webpack Module Federation expects for its `shared` config
 * (the input to `init({ shared })` / `createInstance({ shared })`).
 *
 * These types mirror what `@softarc/native-federation-runtime@3.x` exposed from
 * `getShared()`, so the orchestrator's bridge stays a drop-in for that API.
 */
export type ShareObject = {
  version: string;
  scope?: string;
  get: () => Promise<() => unknown>;
  shareConfig?: {
    singleton?: boolean;
    requiredVersion: string;
  };
};

export type ShareConfig = {
  [packageName: string]: Array<ShareObject>;
};

export type GetSharedOptions = {
  /**
   * Marks the emitted externals as Module Federation singletons. Defaults to
   * `true` — the orchestrator only emits globally shared (`action: 'share'`)
   * externals, which are singletons by definition.
   */
  singleton?: boolean;
  /**
   * When set, the `requiredVersion` is built as `prefix + version` (the v3
   * behaviour). When omitted, the bridge uses the `requiredVersion` negotiated
   * by native federation, falling back to a caret range.
   */
  requiredVersionPrefix?: '^' | '~' | '>' | '>=' | '';
};
