import type { DeepReadonly } from 'lib/utils/deep-readonly';
import type {
  ExternalName,
  RemoteName,
  SharedVersion,
  SharedVersionMeta,
  VersionName,
} from 'lib/core/1.domain';
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
  for (const member of members)
    for (const [remote, records] of recordsByRemote(member)) {
      let copies = shipped.get(remote);
      if (!copies) shipped.set(remote, (copies = []));
      for (const { version, meta } of records)
        copies.push({
          member: member.name,
          tag: version.tag,
          requiredVersion: meta.requiredVersion,
          strict: meta.strictVersion,
          host: version.host && meta === version.remotes[0],
          specifiers: Object.keys(meta.entries),
        });
    }
  return shipped;
}

// One record the remote ships for the member, with the row it sits in.
export type RemoteRecord = DeepReadonly<{ version: SharedVersion; meta: SharedVersionMeta }>;

// A build ships a member at one tag, so a record at a second tag is one it cannot produce; the first tag wins
// whole, so a build never covers a specifier at a tag it does not ship. Several records at that tag are one
// build split across bundles, each its own copy (#133).
export function recordsByRemote(member: PoolMember): Map<RemoteName, RemoteRecord[]> {
  const records = new Map<RemoteName, RemoteRecord[]>();
  for (const version of member.external.versions)
    for (const meta of version.remotes) {
      const mine = records.get(meta.name);
      if (!mine) records.set(meta.name, [{ version, meta }]);
      else if (mine[0]!.version.tag === version.tag) mine.push({ version, meta });
    }
  return records;
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
