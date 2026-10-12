import type { DrivingContract } from 'lib/core/2.app/driving-ports/driving.contract';
import type { IsChunked } from 'lib/core/1.domain/pooling/builds';

// A copy's files import its build's internal chunks: its bundle's (dense chunking), or the `@nf-internal/`
// externals its remote scopes (flat chunking, where no copy names a bundle). Such a file binds that build's
// copy of the package internals wherever it is mapped.
export function createIsChunked(
  ports: Pick<DrivingContract, 'sharedChunksRepo' | 'scopedExternalsRepo'>
): IsChunked {
  return (remote, bundle) =>
    (bundle !== undefined &&
      (ports.sharedChunksRepo.tryGet(remote, bundle).get()?.length ?? 0) > 0) ||
    Object.keys(ports.scopedExternalsRepo.tryGet(remote).get() ?? {}).some(name =>
      name.startsWith('@nf-internal/')
    );
}
