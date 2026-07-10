import { ConfigContract } from 'lib/core/2.app/config';
import { createMockLogHandler } from './handlers/log.handler';

export const mockConfig = (): ConfigContract => ({
  // StorageConfig
  storage: vi.fn().mockImplementation((_: string) => ({
    set: vi.fn().mockReturnThis(),
    get: vi.fn(),
    clear: vi.fn().mockReturnThis(),
  })),
  clearStorage: false,
  // LoggingConfig
  log: createMockLogHandler('debug'),
  sse: false,
  // importMapConfig
  setImportMapFn: vi.fn(),
  loadModuleFn: vi.fn(),
  reloadBrowserFn: vi.fn(),
  // hostConfig
  hostRemoteEntry: false,
  // ModeConfig
  strict: {
    strictRemoteEntry: false,
    strictExternalCompatibility: false,
    strictExternalSameVersionCompatibility: false,
    strictExternalVersion: false,
    strictImportMap: false,
  },
  profile: {
    latestSharedExternal: false,
    skipInvalidExternalVersions: false,
    overrideCachedRemotes: 'always',
    overrideCachedRemotesIfURLMatches: false,
    useAutoExternalPooling: false,
  },
  feature: {
    convertFlatSharedInfo: false,
  },
});
