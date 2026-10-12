import type { DeepReadonly } from 'lib/utils/deep-readonly';
import type { ExternalName, SharedExternal } from './external.contract';
import type { SharedVersion, SharedVersionMeta, VersionName } from './version.contract';
import type { Specifier } from './specifier';
import { forEachVersionEntry } from './basis';

export type Claim = {
  external: ExternalName;
  tag: VersionName;
  copy: SharedVersionMeta;
  from: 'share' | 'skip';
};

export type ClaimTable = {
  // What `imports` serves: share rows in record order, then skip copies; the first claim per specifier wins.
  claims: Map<Specifier, Claim>;
  // Share rows reached after their external's name was claimed: they claim nothing.
  duplicates: Set<DeepReadonly<SharedVersion>>;
  // The first claim per specifier over every share row, duplicates included, which is what a named scope reads.
  shareRows: Map<Specifier, Claim>;
};

export function claimTable(
  externals: Iterable<readonly [ExternalName, DeepReadonly<SharedExternal>]>,
  publishes?: (copy: SharedVersionMeta) => boolean
): ClaimTable {
  const table: ClaimTable = { claims: new Map(), duplicates: new Set(), shareRows: new Map() };
  const ordered = [...externals];

  const claim = (
    into: Map<Specifier, Claim>,
    external: ExternalName,
    version: DeepReadonly<SharedVersion>,
    from: Claim['from']
  ) =>
    forEachVersionEntry(version, publishes, (specifier, copy) => {
      if (!into.has(specifier)) into.set(specifier, { external, tag: version.tag, copy, from });
    });

  for (const [name, external] of ordered)
    for (const version of external.versions) {
      if (version.action !== 'share') continue;
      claim(table.shareRows, name, version, 'share');
      if (table.claims.has(name)) table.duplicates.add(version);
      else claim(table.claims, name, version, 'share');
    }
  for (const [name, external] of ordered)
    for (const version of external.versions)
      if (version.action === 'skip') claim(table.claims, name, version, 'skip');

  return table;
}
