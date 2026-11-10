import type { DrivingContract } from '../driving-ports/driving.contract';
import type { ImportMap, RemoteName, ScopedVersion } from 'lib/core/1.domain';
import {
  eagerPreloadUrls,
  type PreloadCandidate,
} from 'lib/core/1.domain/import-map/eager-preloads';

export type CollectEagerPreloads = (importMap: ImportMap) => string[];

type Copy = Pick<ScopedVersion, 'preload' | 'bundle' | 'entries'>;

export function createCollectEagerPreloads(
  ports: Pick<
    DrivingContract,
    'remoteInfoRepo' | 'scopedExternalsRepo' | 'sharedExternalsRepo' | 'sharedChunksRepo'
  >
): CollectEagerPreloads {
  return importMap => eagerPreloadUrls(importMap, candidates());

  // A copy brings every chunk of its own bundle, as the map's CHUNKS scope of its remote lists them.
  function* candidates(): Generator<PreloadCandidate> {
    for (const [remoteName, copy] of storedCopies()) {
      if (!copy.preload) continue;
      const scopeUrl = ports.remoteInfoRepo.tryGet(remoteName).get()?.scopeUrl;
      if (!scopeUrl) continue;
      yield {
        scopeUrl,
        entryFiles: Object.values(copy.entries),
        ...(copy.bundle && {
          bundle: {
            name: copy.bundle,
            chunkFiles: ports.sharedChunksRepo.tryGet(remoteName, copy.bundle).orElse([]),
          },
        }),
      };
    }
  }

  function* storedCopies(): Generator<[RemoteName, Copy]> {
    const shared = ports.sharedExternalsRepo;
    for (const shareScope of shared.getScopes())
      for (const external of Object.values(shared.getFromScope(shareScope)))
        for (const version of external.versions)
          for (const copy of version.remotes) yield [copy.name, copy];
    for (const [remoteName, externals] of Object.entries(ports.scopedExternalsRepo.getAll()))
      for (const copy of Object.values(externals)) yield [remoteName, copy];
  }
}
