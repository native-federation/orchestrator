import type { RemoteName } from '../remote/remote-info.contract';
import type { SharedVersion, ScopedVersion } from './version.contract';

export type ExternalName = string;

export type ScopedExternals = Record<string, ScopedExternal>;

export const GLOBAL_SCOPE = '__GLOBAL__';

export const STRICT_SCOPE = 'strict';

export type SharedExternal = {
  dirty: boolean;
  // The pool this external resolves in, as pooling last computed it; absent when it is in none.
  poolName?: string;
  // The build its pool's last election made global; a tied re-election keeps it.
  poolWinner?: RemoteName;
  versions: SharedVersion[];
};

export type shareScope = Record<string, SharedExternal>;

export type SharedExternals = Record<string, shareScope> & { [GLOBAL_SCOPE]: shareScope };

export type ScopedExternal = Record<string, ScopedVersion>;
