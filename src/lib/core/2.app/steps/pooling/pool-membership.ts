import type { ExternalName } from 'lib/core/1.domain';
import type { LogHandler } from '../../config/log.contract';
import type { PoolName } from './pool.types';

/** Matches a scoped npm package name, capturing the scope without the leading `@`. */
const SCOPED_PACKAGE = /^@([^/]+)\//;

/**
 * Resolve which pool (if any) a shared external belongs to. Pure; no I/O.
 *
 * Precedence:
 *  1. a non-empty remote-declared `pool` tag (from `SharedInfo.pool`, carried on
 *     `SharedVersionMeta.pool`) — the explicit override, always honored;
 *  2. otherwise, when `useAutoExternalPooling` is enabled, the external's npm scope
 *     ("company"), e.g. `@angular/core` -> `angular`. Scoped packages only — an
 *     unscoped name (`rxjs`, `tslib`) is never auto-pooled.
 *
 * At most one pool per external. Conflicting non-empty tags across remotes -> warn and
 * pick the first (sorted, stable); an explicit tag always beats auto-derivation.
 */
export function resolvePoolMembership(
  externalName: ExternalName,
  remotePoolTags: readonly string[],
  useAutoExternalPooling: boolean,
  log?: LogHandler
): PoolName | undefined {
  const tags = [
    ...new Set(remotePoolTags.map(t => t?.trim()).filter((t): t is string => !!t)),
  ].sort();

  if (tags.length > 0) {
    if (tags.length > 1) {
      log?.warn(
        3,
        `[${externalName}] Conflicting pool tags [${tags.join(', ')}] declared across remotes; using '${tags[0]}'.`
      );
    }
    return tags[0];
  }

  if (useAutoExternalPooling) {
    const scope = SCOPED_PACKAGE.exec(externalName)?.[1];
    if (scope) return scope;
  }

  return undefined;
}
