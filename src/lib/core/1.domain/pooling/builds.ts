import type { ExternalName, RemoteName, VersionName } from 'lib/core/1.domain';
import { type Specifier, SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import type { PoolMember } from './membership';

// What one remote's build ships for a pool, read from the stored record; the election and the dynamic gate
// both read it, keyed by specifier so flat and dense builds of one package compare.

export type Copy = {
  member: ExternalName;
  tag: VersionName;
  requiredVersion: string;
  strict: boolean;
  specifiers: Specifier[];
};

export type Build = {
  owner: RemoteName;
  tags: SpecifierTags;
  tagByMember: Map<ExternalName, VersionName>;
};

export function copiesByRemote(members: PoolMember[]): Map<RemoteName, Copy[]> {
  const shipped = new Map<RemoteName, Copy[]>();
  for (const member of members)
    for (const version of member.external.versions)
      for (const meta of version.remotes) {
        let copies = shipped.get(meta.name);
        if (!copies) shipped.set(meta.name, (copies = []));
        // A remote ships one copy per member, so a second row is a record it cannot produce; the first row
        // wins whole, entries included, so a build never covers a specifier at a tag it does not ship.
        if (!copies.some(c => c.member === member.name))
          copies.push({
            member: member.name,
            tag: version.tag,
            requiredVersion: meta.requiredVersion,
            strict: meta.strictVersion,
            specifiers: Object.keys(meta.entries),
          });
      }
  return shipped;
}

export function buildOf(owner: RemoteName, copies: readonly Copy[]): Build {
  const tags = new SpecifierTags();
  const tagByMember = new Map<ExternalName, VersionName>();
  for (const copy of copies) {
    for (const specifier of copy.specifiers)
      if (!tags.has(specifier)) tags.set(specifier, copy.tag);
    tagByMember.set(copy.member, copy.tag);
  }
  return { owner, tags, tagByMember };
}
