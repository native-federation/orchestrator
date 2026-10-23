import type { DenseSharedInfo, RemoteSharedInfo, SharedInfo } from './remote-entry.contract';

// Runs on the raw `shared` array: normalizing wraps a flat entry into the dense shape, after which the two
// can't be told apart.
export function markDense(
  shared: (SharedInfo | DenseSharedInfo)[]
): (SharedInfo | RemoteSharedInfo)[] {
  return shared.map(entry => ('entries' in entry ? { ...entry, dense: true } : entry));
}
