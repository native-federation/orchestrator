import type { SharedVersionAction } from '../externals/version.contract';
import type { RemoteEntryUrl } from './manifest.contract';
import type {
  DenseSharedInfo,
  ExposesInfo,
  FederationInfo,
  SharedInfo,
} from '@softarc/native-federation/domain';

type RawRemoteEntry = FederationInfo;

const CHUNK_PREFIX = '@nf-internal';

type RemoteEntry = Omit<FederationInfo, 'shared'> & {
  shared: DenseSharedInfo[];
  url: RemoteEntryUrl;
  host?: boolean;
  override?: boolean;
};

function toDenseSharedInfoFormat(shared: Array<SharedInfo | DenseSharedInfo>): DenseSharedInfo[] {
  return shared.map(external => {
    if ('entries' in external) return external;
    const { outFileName, ...baseSharedInfoProps } = external;
    return {
      ...baseSharedInfoProps,
      entries: { [external.packageName]: outFileName },
    };
  });
}

function inferPackageFromSecondary(secondary: string): string {
  const parts = secondary.split('/');
  if (secondary.startsWith('@') && parts.length >= 2) {
    return parts[0] + '/' + parts[1];
  }
  return parts[0] ?? secondary;
}

function densifyExternals(
  shared: Array<SharedInfo | DenseSharedInfo>
): Array<SharedInfo | DenseSharedInfo> {
  const result: Array<SharedInfo | DenseSharedInfo> = [];
  const groupIndex = new Map<string, number>();
  for (const entry of shared) {
    const isDense = 'entries' in entry;
    const isChunk = entry.packageName.startsWith(CHUNK_PREFIX + '/');
    if (isDense || isChunk) {
      result.push(entry);
      continue;
    }
    const parent = inferPackageFromSecondary(entry.packageName);
    const sig = JSON.stringify({
      singleton: entry.singleton,
      strictVersion: entry.strictVersion,
      requiredVersion: entry.requiredVersion,
      version: entry.version,
      shareScope: entry.shareScope,
    });
    const key = parent + ' ' + sig;
    const existing = groupIndex.get(key);
    if (existing === undefined) {
      const dense: DenseSharedInfo = {
        singleton: entry.singleton,
        strictVersion: entry.strictVersion,
        requiredVersion: entry.requiredVersion,
        packageName: parent,
        entries: { [entry.packageName]: entry.outFileName },
      };
      if (entry.version !== undefined) dense.version = entry.version;
      if (entry.shareScope !== undefined) dense.shareScope = entry.shareScope;
      if (entry.bundle !== undefined) dense.bundle = entry.bundle;
      if (entry.dev !== undefined) dense.dev = entry.dev;
      groupIndex.set(key, result.length);
      result.push(dense);
    } else {
      (result[existing] as DenseSharedInfo).entries[entry.packageName] = entry.outFileName;
    }
  }
  return result;
}

type SharedInfoActions = Record<
  string,
  { action: SharedVersionAction; override?: Record<string, string> }
>;

export {
  RawRemoteEntry,
  RemoteEntry,
  FederationInfo,
  ExposesInfo,
  SharedInfo,
  DenseSharedInfo,
  SharedInfoActions,
  toDenseSharedInfoFormat,
  densifyExternals,
};
