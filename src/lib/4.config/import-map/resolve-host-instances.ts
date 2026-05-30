import type { HostOptions } from 'lib/2.app/config/host.contract';
import type { LogHandler } from 'lib/2.app/config/log.contract';
import type { ForProvidingRemoteEntries } from 'lib/2.app/driving-ports/for-providing-remote-entries.port';

/** Specifier → module namespace object to bridge into remotes (the host's own instances). */
export type HostInstanceMap = Record<string, object>;

/**
 * Auto-derive the bridged specifiers from the host remoteEntry's shared
 * singletons instead of listing them by hand. Each derived specifier is loaded
 * in the host realm (so the captured instance is the host's) and published.
 */
export type HostInstancesAuto = {
  /** Only bridge specifiers matching one of these (exact or prefix, e.g. `'@angular/'`). */
  include?: string[];
  /** Never bridge specifiers matching one of these (exact or prefix). */
  exclude?: string[];
  /**
   * How to load each instance. Default: `(s) => import(s)`.
   *
   * The default resolves wherever this library runs. Under a bundler-driven dev
   * server (e.g. Vite SSR) that may NOT be the realm holding the host's running
   * instance — pass a `load` defined in your own host entry so the import
   * resolves through the host's module graph and captures the real instance.
   */
  load?: (specifier: string) => Promise<object>;
};

export type HostInstancesOption =
  /** Explicit map of specifier → already-loaded namespace. */
  | HostInstanceMap
  /** Auto-derive every shared singleton from the host remoteEntry. */
  | 'all'
  /** Auto-derive, filtered. */
  | HostInstancesAuto;

type Deps = {
  remoteEntryProvider: ForProvidingRemoteEntries;
  hostRemoteEntry: HostOptions['hostRemoteEntry'];
  log: LogHandler;
};

/** A pattern matches a specifier on exact equality or as a prefix. */
const matches = (specifier: string, patterns: string[]): boolean =>
  patterns.some(p => specifier === p || specifier.startsWith(p));

/** Distinguish the auto forms (`'all'` / filter object) from an explicit map. */
const isAuto = (option: HostInstancesOption): option is 'all' | HostInstancesAuto =>
  option === 'all' ||
  (typeof option === 'object' &&
    option !== null &&
    ('include' in option || 'exclude' in option || 'load' in option));

/**
 * Turn the `hostInstances` option into a concrete `{ specifier: namespace }` map.
 *
 * - Explicit map → returned as-is.
 * - `'all'` / `{ include, exclude }` → read the host remoteEntry's shared
 *   singletons, apply the filter, and import each in the host realm.
 *
 * A specifier that fails to load is skipped with a warning rather than aborting
 * init — the remote falls back to import-map resolution for it (which is the
 * pre-bridge behaviour).
 */
export const resolveHostInstances = async (
  option: HostInstancesOption | undefined,
  deps: Deps
): Promise<HostInstanceMap | undefined> => {
  if (!option) return undefined;
  if (!isAuto(option)) return option;

  const auto: HostInstancesAuto = option === 'all' ? {} : option;

  const { hostRemoteEntry } = deps;
  if (!hostRemoteEntry) {
    deps.log.warn(
      0,
      '[native-federation] hostInstances auto mode needs a hostRemoteEntry to derive shared singletons from; skipping.'
    );
    return undefined;
  }

  const url = typeof hostRemoteEntry === 'string' ? hostRemoteEntry : hostRemoteEntry.url;
  const integrity = typeof hostRemoteEntry === 'string' ? undefined : hostRemoteEntry.integrity;
  const entry = await deps.remoteEntryProvider.provide(url, { integrity });

  const load = auto.load ?? ((specifier: string) => import(specifier));

  const specifiers = [...new Set((entry.shared ?? []).filter(s => s.singleton).map(s => s.packageName))]
    .filter(s => (auto.include ? matches(s, auto.include) : true))
    .filter(s => (auto.exclude ? !matches(s, auto.exclude) : true));

  const map: HostInstanceMap = {};
  for (const specifier of specifiers) {
    try {
      map[specifier] = (await load(specifier)) as object;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        0,
        `[native-federation] hostInstances: could not load '${specifier}' from the host realm; skipping (${msg})`
      );
    }
  }

  deps.log.debug(0, `[native-federation] hostInstances bridged: ${Object.keys(map).join(', ') || '(none)'}`);
  return map;
};
