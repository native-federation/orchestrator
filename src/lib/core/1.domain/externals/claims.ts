import type { DeepReadonly } from 'lib/utils/deep-readonly';
import type { RemoteName } from '../remote/remote-info.contract';
import { type ExternalName, GLOBAL_SCOPE, type SharedExternal } from './external.contract';
import type { SharedVersion, SharedVersionMeta, VersionName } from './version.contract';
import type { Specifier } from './specifier';
import { forEachVersionEntry } from './basis';

export type Claim = {
  external: ExternalName;
  tag: VersionName;
  copy: SharedVersionMeta;
};

export type ClaimTable = {
  // What `imports` serves: each external's serving build, then share rows in record order; the first claim per
  // specifier wins. A skip copy claims nothing.
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
    accepts = publishes
  ) =>
    forEachVersionEntry(version, accepts, (specifier, copy) => {
      if (!into.has(specifier)) into.set(specifier, { external, tag: version.tag, copy });
    });

  const seedServingBuild = (name: ExternalName, external: DeepReadonly<SharedExternal>) => {
    const isServing = (copy: SharedVersionMeta) =>
      copy.name === external.servingBuild && (!publishes || publishes(copy));
    for (const version of external.versions) {
      if (version.action !== 'share') continue;
      claim(table.shareClaims, name, version, isServing);
      claim(table.claims, name, version, isServing);
    }
  };

  const claimShareRow = (name: ExternalName, version: DeepReadonly<SharedVersion>) => {
    claim(table.shareClaims, name, version);
    const prior = table.claims.get(name);
    // The seed already claimed this row's name; the row still claims what the serving copy doesn't ship.
    if (!prior || (prior.external === name && prior.tag === version.tag))
      claim(table.claims, name, version);
    else if (prior.tag !== version.tag) table.duplicates.add(version);
  };

  for (const [name, external] of ordered)
    if (external.servingBuild) seedServingBuild(name, external);
  for (const [name, external] of ordered)
    for (const version of external.versions)
      if (version.action === 'share') claimShareRow(name, version);

  return table;
}

// What a committed map serves in one scope, from externals in record order: `imports` holds only the copies
// marked cached, a named scope's override may name any copy. `without` is a loaded remote whose copies the
// record already holds but the committed map does not.
export function committedClaims(
  externals: Iterable<readonly [ExternalName, DeepReadonly<SharedExternal>]>,
  { shareScope, without }: { shareScope: string; without?: RemoteName }
): Map<Specifier, Claim> {
  const publishes = (copy: SharedVersionMeta) =>
    copy.name !== without && (shareScope !== GLOBAL_SCOPE || copy.cached);
  return claimTable(externals, publishes).claims;
}

// One version's claims, ordered as `claimTable` orders them within a tag: the serving copy, then record order.
export function versionClaims(
  version: DeepReadonly<SharedVersion>,
  servingBuild?: RemoteName
): Map<Specifier, SharedVersionMeta> {
  const claims = new Map<Specifier, SharedVersionMeta>();
  const claim = (specifier: Specifier, copy: SharedVersionMeta) => {
    if (!claims.has(specifier)) claims.set(specifier, copy);
  };
  if (servingBuild) forEachVersionEntry(version, copy => copy.name === servingBuild, claim);
  forEachVersionEntry(version, undefined, claim);
  return claims;
}
