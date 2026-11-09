import type { ImportMap } from './import-map.contract';

export type PreloadCandidate = { entryUrls: string[]; chunkUrls: string[] };

// Only a copy the map serves whole counts: a flag on a copy that lost version resolution does nothing, and a
// copy served in part would preload chunks of entries another copy serves.
export function eagerPreloadUrls(
  importMap: ImportMap,
  candidates: Iterable<PreloadCandidate>
): string[] {
  const mapped = new Set([
    ...Object.values(importMap.imports),
    ...Object.values(importMap.scopes ?? {}).flatMap(scope => Object.values(scope)),
  ]);
  const urls = new Set<string>();
  for (const { entryUrls, chunkUrls } of candidates) {
    if (!entryUrls.every(url => mapped.has(url))) continue;
    entryUrls.forEach(url => urls.add(url));
    chunkUrls.forEach(url => urls.add(url));
  }
  return [...urls];
}
