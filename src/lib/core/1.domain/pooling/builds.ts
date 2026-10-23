import type { ExternalName, RemoteName, VersionName } from 'lib/core/1.domain';
import {
  type PackageOf,
  type Specifier,
  SpecifierTags,
} from 'lib/core/1.domain/externals/specifier';
import type { PoolMember } from './membership';

// Keyed by specifier so flat and dense builds of one package compare.

export type Copy = {
  member: ExternalName;
  tag: VersionName;
  requiredVersion: string;
  strict: boolean;
  // Basis precedence puts the host's own copy first on a `host: true` version.
  host: boolean;
  specifiers: Specifier[];
};

export type Build = {
  owner: RemoteName;
  tags: SpecifierTags;
  tagByMember: Map<ExternalName, VersionName>;
  host: boolean;
};

export function copiesByRemote(members: readonly PoolMember[]): Map<RemoteName, Copy[]> {
  const shipped = new Map<RemoteName, Copy[]>();
  for (const member of members) {
    const seen = new Set<RemoteName>();
    for (const version of member.external.versions)
      for (const meta of version.remotes) {
        // A remote ships one copy per member, so a second row is a record it cannot produce; the first row
        // wins whole, entries included, so a build never covers a specifier at a tag it does not ship.
        if (seen.has(meta.name)) continue;
        seen.add(meta.name);
        let copies = shipped.get(meta.name);
        if (!copies) shipped.set(meta.name, (copies = []));
        copies.push({
          member: member.name,
          tag: version.tag,
          requiredVersion: meta.requiredVersion,
          strict: meta.strictVersion,
          host: version.host && meta === version.remotes[0],
          specifiers: Object.keys(meta.entries),
        });
      }
  }
  return shipped;
}

export const specifierCount = (copies: readonly Copy[]): number =>
  copies.reduce((n, copy) => n + copy.specifiers.length, 0);

export function buildOf(owner: RemoteName, copies: readonly Copy[], packageOf: PackageOf): Build {
  const tags = new SpecifierTags(packageOf);
  const tagByMember = new Map<ExternalName, VersionName>();
  for (const copy of copies) {
    for (const specifier of copy.specifiers)
      if (!tags.has(specifier)) tags.set(specifier, copy.tag);
    tagByMember.set(copy.member, copy.tag);
  }
  return { owner, tags, tagByMember, host: copies.some(c => c.host) };
}
