export type RemoteRef = string | { name?: string; integrity?: string };

export type DynamicInitResult<TFederationResult = {}> = TFederationResult & {
  initRemoteEntry: (
    remoteEntryUrl: string,
    remote?: RemoteRef
  ) => Promise<DynamicInitResult<TFederationResult>>;
};

export type DynamicInitFlow = (
  remoteEntryUrl: string,
  remote?: RemoteRef
) => Promise<DynamicInitResult>;
