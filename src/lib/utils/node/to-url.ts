import { pathToFileURL } from 'node:url';
import type { HostOptions } from 'lib/2.app/config/host.contract';

/**
 * Coerce a Node-side string into a URL string. Anything that already starts
 * with a scheme (`http:`, `https:`, `file:`, `node:`, …) passes through; a bare
 * filesystem path is converted to a `file://` URL via `pathToFileURL`.
 */
const URL_SCHEME = /^[a-z][a-z0-9+\-.]*:/i;

export const toUrl = (pathOrUrl: string): string =>
  URL_SCHEME.test(pathOrUrl) ? pathOrUrl : pathToFileURL(pathOrUrl).href;

export const normalizeHostRemoteEntry = (
  hostRemoteEntry: HostOptions['hostRemoteEntry']
): HostOptions['hostRemoteEntry'] => {
  if (!hostRemoteEntry) return hostRemoteEntry;
  if (typeof hostRemoteEntry === 'string') return toUrl(hostRemoteEntry);
  return { ...hostRemoteEntry, url: toUrl(hostRemoteEntry.url) };
};
