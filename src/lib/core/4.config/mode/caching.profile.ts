import type { ModeProfileConfig } from 'lib/core/2.app/config/mode.contract';

export const cachingProfile: ModeProfileConfig = {
  latestSharedExternal: false,
  overrideCachedRemotes: 'never',
  overrideCachedRemotesIfURLMatches: false,
};
