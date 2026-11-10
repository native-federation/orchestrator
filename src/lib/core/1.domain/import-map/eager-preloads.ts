import type { ImportMap } from './import-map.contract';
import * as _path from 'lib/utils/path';

export type PreloadCandidate = {
  scopeUrl: string;
  entryFiles: string[];
  bundle?: { name: string; chunkFiles: string[] };
};

// Only a copy the map serves whole counts: a flag on a copy that lost version resolution does nothing, and a
// copy served in part would preload chunks of entries another copy serves.
export function eagerPreloadUrls(
  importMap: ImportMap,
  candidates: Iterable<PreloadCandidate>
): string[] {
  let mapped: Set<string> | undefined;
  const urls = new Set<string>();
  const bundlesAdded = new Set<string>();
  for (const { scopeUrl, entryFiles, bundle } of candidates) {
    mapped ??= mappedUrls(importMap);
    const entryUrls = entryFiles.map(file => _path.join(scopeUrl, file));
    const served = entryUrls.length > 0 && entryUrls.every(url => mapped!.has(url));
    if (!served) continue;
    entryUrls.forEach(url => urls.add(url));
    if (!bundle) continue;
    // Several copies of one remote share a bundle, so its chunks are joined once.
    const bundleKey = `${scopeUrl}\n${bundle.name}`;
    if (bundlesAdded.has(bundleKey)) continue;
    bundlesAdded.add(bundleKey);
    bundle.chunkFiles.forEach(file => urls.add(_path.join(scopeUrl, file)));
  }
  return [...urls];
}

const mappedUrls = (importMap: ImportMap) =>
  new Set([
    ...Object.values(importMap.imports),
    ...Object.values(importMap.scopes ?? {}).flatMap(scope => Object.values(scope)),
  ]);
