import type { HostConfig, HostOptions } from 'lib/2.app/config/host.contract';

export const createHostConfig = (override: Partial<HostOptions>): HostConfig => {
  const extras = override?.manifestIntegrity
    ? { manifestIntegrity: override.manifestIntegrity }
    : {};

  if (!override?.hostRemoteEntry) {
    return { hostRemoteEntry: false, ...extras };
  }
  if (typeof override.hostRemoteEntry === 'string') {
    return {
      hostRemoteEntry: {
        name: '__NF-HOST__',
        url: override.hostRemoteEntry,
      },
      ...extras,
    };
  }
  return {
    hostRemoteEntry: {
      name: '__NF-HOST__',
      ...override.hostRemoteEntry,
    },
    ...extras,
  };
};
