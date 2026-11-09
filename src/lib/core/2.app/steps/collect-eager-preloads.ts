import type { DrivingContract } from '../driving-ports/driving.contract';
import type { ImportMap, RemoteName } from 'lib/core/1.domain';
import {
  eagerPreloadUrls,
  type PreloadCandidate,
} from 'lib/core/1.domain/import-map/eager-preloads';
import * as _path from 'lib/utils/path';

export type CollectEagerPreloads = (importMap: ImportMap) => string[];

export function createCollectEagerPreloads(
  ports: Pick<
    DrivingContract,
    'remoteInfoRepo' | 'scopedExternalsRepo' | 'sharedExternalsRepo' | 'sharedChunksRepo'
  >
): CollectEagerPreloads {
  return importMap => eagerPreloadUrls(importMap, candidates());

  function* candidates(): Generator<PreloadCandidate> {
    const shared = ports.sharedExternalsRepo;
    for (const shareScope of shared.getScopes()) {
      for (const external of Object.values(shared.getFromScope(shareScope))) {
        for (const version of external.versions) {
          for (const copy of version.remotes) yield* candidate(copy.name, copy);
        }
      }
    }
    for (const [remoteName, externals] of Object.entries(ports.scopedExternalsRepo.getAll())) {
      for (const version of Object.values(externals)) yield* candidate(remoteName, version);
    }
  }

  // A copy brings every chunk of its own bundle, as the map's CHUNKS scope of its remote lists them.
  function* candidate(
    remoteName: RemoteName,
    copy: { preload?: true; bundle?: string; entries: Record<string, string> }
  ): Generator<PreloadCandidate> {
    if (!copy.preload) return;
    const scopeUrl = ports.remoteInfoRepo.tryGet(remoteName).get()?.scopeUrl;
    if (!scopeUrl) return;
    const chunks = copy.bundle
      ? (ports.sharedChunksRepo.tryGet(remoteName, copy.bundle).get() ?? [])
      : [];
    yield {
      entryUrls: Object.values(copy.entries).map(file => _path.join(scopeUrl, file)),
      chunkUrls: chunks.map(file => _path.join(scopeUrl, file)),
    };
  }
}
