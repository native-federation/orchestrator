import type { DeepReadonly } from 'lib/utils/deep-readonly';
import type { ExternalName, SharedExternal } from './external.contract';
import type { SharedVersion, SharedVersionMeta, VersionName } from './version.contract';
import type { Specifier } from './specifier';
import { forEachVersionEntry } from './basis';

export type Claim = {
  external: ExternalName;
  tag: VersionName;
  copy: SharedVersionMeta;
  action: 'share' | 'skip';
};

export type ClaimTable = {
  // What `imports` serves: each external's serving build, then share rows in record order, then skip copies;
  // the first claim per specifier wins. Without `publishes`, every entry of a copy not served by another build
  // has a claim.
  claims: Map<Specifier, Claim>;
  // Share rows reached after their external's name was claimed at another tag. A row whose name another row
  // claimed claims nothing, duplicate or not.
  duplicates: Set<DeepReadonly<SharedVersion>>;
  // The first claim per specifier over every share row, duplicates included, which is what a named scope reads.
  shareClaims: Map<Specifier, Claim>;
};

export function claimTable(
  externals: Iterable<readonly [ExternalName, DeepReadonly<SharedExternal>]>,
  publishes?: (copy: SharedVersionMeta) => boolean
): ClaimTable {
  const table: ClaimTable = { claims: new Map(), duplicates: new Set(), shareClaims: new Map() };
  const ordered = [...externals];

  const claim = (
    into: Map<Specifier, Claim>,
    external: ExternalName,
    version: DeepReadonly<SharedVersion>,
    action: Claim['action'],
    accepts = publishes
  ) =>
    forEachVersionEntry(version, accepts, (specifier, copy) => {
      if (!into.has(specifier)) into.set(specifier, { external, tag: version.tag, copy, action });
    });

  const seedServingBuild = (name: ExternalName, external: DeepReadonly<SharedExternal>) => {
    const isServing = (copy: SharedVersionMeta) =>
      copy.name === external.servingBuild && (!publishes || publishes(copy));
    for (const version of external.versions) {
      if (version.action !== 'share') continue;
      claim(table.shareClaims, name, version, 'share', isServing);
      claim(table.claims, name, version, 'share', isServing);
    }
  };

  const claimShareRow = (name: ExternalName, version: DeepReadonly<SharedVersion>) => {
    claim(table.shareClaims, name, version, 'share');
    const prior = table.claims.get(name);
    // The seed already claimed this row's name; the row still claims what the serving copy doesn't ship.
    if (!prior || (prior.external === name && prior.tag === version.tag))
      claim(table.claims, name, version, 'share');
    else if (prior.tag !== version.tag) table.duplicates.add(version);
  };

  for (const [name, external] of ordered)
    if (external.servingBuild) seedServingBuild(name, external);
  for (const [name, external] of ordered)
    for (const version of external.versions)
      if (version.action === 'share') claimShareRow(name, version);
  for (const [name, external] of ordered)
    for (const version of external.versions)
      if (version.action === 'skip') claim(table.claims, name, version, 'skip');

  return table;
}
