import { cachingProfile } from './caching.profile';
import { defaultProfile } from './default.profile';
import { createModeConfig } from './mode.config';

describe('config.mode', () => {
  it('should set balanced caching when default profile is chosen', () => {
    const config = createModeConfig({ profile: defaultProfile });
    expect(config.profile).toEqual({
      latestSharedExternal: false,
      skipInvalidExternalVersions: false,
      overrideCachedRemotes: 'init-only',
      overrideCachedRemotesIfURLMatches: false,
    });
  });
  it('should set most optimal caching when caching profile is chosen', () => {
    const config = createModeConfig({ profile: cachingProfile });
    expect(config.profile).toEqual({
      latestSharedExternal: false,
      skipInvalidExternalVersions: false,
      overrideCachedRemotes: 'never',
      overrideCachedRemotesIfURLMatches: false,
    });
  });

  it('should set the default profile when no profile is specified', () => {
    const config = createModeConfig({});
    expect(config.profile).toEqual(defaultProfile);
  });

  it('should set strict: false by default', () => {
    const config = createModeConfig({});
    expect(config.strict).toEqual({
      strictRemoteEntry: false,
      strictExternalCompatibility: false,
      strictExternalSameVersionCompatibility: false,
      strictExternalVersion: false,
      strictImportMap: false,
      strictEntryPointCoverage: false,
    });
  });

  it('should expand a strict: true shorthand to every strict flag, coverage included', () => {
    const config = createModeConfig({ strict: true });
    expect(config.strict).toEqual({
      strictRemoteEntry: true,
      strictExternalCompatibility: true,
      strictExternalSameVersionCompatibility: true,
      strictExternalVersion: true,
      strictImportMap: true,
      strictEntryPointCoverage: true,
    });
  });

  it('should default strictEntryPointCoverage to false when other strict flags are set', () => {
    const config = createModeConfig({ strict: { strictImportMap: true } });
    expect(config.strict.strictEntryPointCoverage).toBe(false);
    expect(config.strict.strictImportMap).toBe(true);
  });
});
