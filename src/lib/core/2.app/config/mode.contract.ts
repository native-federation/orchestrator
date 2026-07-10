export type ModeProfileConfig = {
  latestSharedExternal: boolean;
  skipInvalidExternalVersions: boolean;
  overrideCachedRemotes: 'always' | 'never' | 'init-only';
  overrideCachedRemotesIfURLMatches: boolean;
  cacheTag?: string;
};

export type ModeFeatureConfig = {
  convertFlatSharedInfo: boolean;
};

export type ModeStrictnessConfig = {
  strictRemoteEntry: boolean;
  strictExternalCompatibility: boolean;
  strictExternalSameVersionCompatibility: boolean;
  strictExternalVersion: boolean;
  strictImportMap: boolean;
};

export type ModeConfig = {
  strict: ModeStrictnessConfig;
  profile: ModeProfileConfig;
  feature: ModeFeatureConfig;
};

export type ModeOptions = {
  strict?: Partial<ModeStrictnessConfig> | boolean;
  profile?: Partial<ModeProfileConfig>;
  feature?: Partial<ModeFeatureConfig>;
};
