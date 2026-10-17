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
    });
  });

  it('should expand a strict: true shorthand to every strict flag', () => {
    const config = createModeConfig({ strict: true });
    expect(config.strict).toEqual({
      strictRemoteEntry: true,
      strictExternalCompatibility: true,
      strictExternalSameVersionCompatibility: true,
      strictExternalVersion: true,
      strictImportMap: true,
    });
  });

  // Both options were removed in 4.8.0; they stay on the options type so 4.7.0 configs still compile.
  it('should accept and ignore the removed entrypoint-coverage options', () => {
    const config = createModeConfig({
      strict: { strictEntryPointCoverage: true },
      profile: { scopeUncoveredEntrypoints: true },
    });
    expect(config.strict).toEqual(createModeConfig({}).strict);
    expect(config.strict).not.toHaveProperty('strictEntryPointCoverage');
  });
});
