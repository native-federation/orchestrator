import type { shareScope } from 'lib/core/1.domain';

// Stands in for the build-time default that replaced `useAutoExternalPooling`: a scoped package declared
// without a `pool` label is labelled with its npm scope (`@framework/core` -> `framework`). Explicit labels win.
const SCOPED_PACKAGE = /^@([^/]+)\//;

export const npmScope = (name: string): string | undefined => SCOPED_PACKAGE.exec(name)?.[1];

/** Remote-entry side: labels each unlabelled scoped `shared` item, returning new objects. */
export const labelSharedInfoByNpmScope = <T extends { packageName: string; pool?: string }>(
  shared: readonly T[]
): T[] =>
  shared.map(item => {
    const scope = npmScope(item.packageName);
    return item.pool?.trim() || scope === undefined ? item : { ...item, pool: scope };
  });

/** Storage side: labels every unlabelled copy of a scoped external in place, returning the same record. */
export const labelStoredByNpmScope = <T extends shareScope>(externals: T): T => {
  for (const [name, external] of Object.entries(externals)) {
    const scope = npmScope(name);
    if (scope === undefined) continue;
    for (const version of external.versions)
      for (const meta of version.remotes) if (!meta.pool?.trim()) meta.pool = scope;
  }
  return externals;
};
