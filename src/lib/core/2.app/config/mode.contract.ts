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
  strict?:
    | (Partial<ModeStrictnessConfig> & {
        /** @deprecated Removed in 4.8.0 and ignored: a package always runs from one build. */
        strictEntryPointCoverage?: boolean;
      })
    | boolean;
  profile?: Partial<ModeProfileConfig> & {
    /** @deprecated Removed in 4.8.0 and ignored: a package always runs from one build. */
    scopeUncoveredEntrypoints?: boolean;
  };
  feature?: Partial<ModeFeatureConfig>;
};
