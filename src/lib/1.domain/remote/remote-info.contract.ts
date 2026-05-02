import type { RemoteModule } from './remote-module.contract';

export type RemoteName = string;

export type RemoteScope = string;

export type RemoteIntegrity = Record<string, string>;

export type RemoteInfo = {
  scopeUrl: RemoteScope;
  exposes: RemoteModule[];
  integrity?: RemoteIntegrity;
};

export type Remotes = Record<string, RemoteInfo>;
