import type { ModeConfig, ModeOptions } from 'lib/core/2.app/config/mode.contract';
import { defaultProfile } from './default.profile';

export const createModeConfig = (override: ModeOptions): ModeConfig => {
  const strictnessConfig =
    typeof override.strict === 'boolean'
      ? {
          strictRemoteEntry: override.strict,
          strictExternalCompatibility: override.strict,
          strictExternalSameVersionCompatibility: override.strict,
          strictExternalVersion: override.strict,
          strictImportMap: override.strict,
          strictEntryPointCoverage: override.strict,
        }
      : {
          strictRemoteEntry: override.strict?.strictRemoteEntry ?? false,
          strictExternalCompatibility: override.strict?.strictExternalCompatibility ?? false,
          strictExternalSameVersionCompatibility:
            override.strict?.strictExternalSameVersionCompatibility ?? false,
          strictExternalVersion: override.strict?.strictExternalVersion ?? false,
          strictImportMap: override.strict?.strictImportMap ?? false,
          strictEntryPointCoverage: override.strict?.strictEntryPointCoverage ?? false,
        };

  return {
    strict: strictnessConfig,
    profile: { ...defaultProfile, ...(override.profile ?? {}) },
    feature: {
      convertFlatSharedInfo: override.feature?.convertFlatSharedInfo ?? false,
      useAutoExternalPooling: override.feature?.useAutoExternalPooling ?? false,
    },
  };
};
