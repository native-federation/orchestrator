import type {
  RawRemoteEntry,
  RemoteEntry,
} from 'lib/core/1.domain/remote-entry/remote-entry.contract';
import type { ModeConfig } from 'lib/core/2.app/config/mode.contract';
import { markDense } from 'lib/core/1.domain/remote-entry/mark-dense';
import {
  densifyExternals,
  toDenseSharedInfoFormat,
} from '@softarc/native-federation/internal/browser';

const normalizeRemoteEntry = (
  raw: RawRemoteEntry,
  remoteEntryUrl: string,
  config: ModeConfig
): RemoteEntry => {
  const marked = markDense(raw.shared ?? []);
  // Flat entries carry no package declaration, so densifying groups them by npm name.
  const shared = config.feature.convertFlatSharedInfo
    ? densifyExternals(marked, new Map())
    : toDenseSharedInfoFormat(marked);
  const remoteEntry = { ...raw, shared } as RemoteEntry;
  if (!remoteEntry.exposes) remoteEntry.exposes = [];
  if (!remoteEntry.url) remoteEntry.url = remoteEntryUrl;
  return remoteEntry;
};

export { normalizeRemoteEntry };
