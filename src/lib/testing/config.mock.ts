import { ConfigContract } from 'lib/core/2.app/config';
import { createMockLogHandler } from './handlers/log.handler';

export const mockConfig = (): ConfigContract => ({
  storage: vi.fn().mockImplementation((_: string) => ({
    set: vi.fn().mockReturnThis(),
    get: vi.fn(),
    clear: vi.fn().mockReturnThis(),
  })),
  clearStorage: false,
  log: createMockLogHandler('debug'),
  sse: false,
  setImportMapFn: vi.fn(),
  loadModuleFn: vi.fn(),
  reloadBrowserFn: vi.fn(),
  preloadModulesFn: vi.fn(),
  hostRemoteEntry: false,
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
  },
  feature: {
    convertFlatSharedInfo: false,
  },
});
