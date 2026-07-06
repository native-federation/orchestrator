import type { ModeProfileConfig } from 'lib/core/2.app/config/mode.contract';

export const defaultProfile: ModeProfileConfig = {
  latestSharedExternal: false,
  skipInvalidExternalVersions: false,
  overrideCachedRemotes: 'init-only',
  overrideCachedRemotesIfURLMatches: false,
  useAutoExternalPooling: false,
};
