import type { AcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import type { SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import type { Build, Copy } from './builds';

// One remote's copies against a set of tags, as the election and the dynamic gate both judge them; see
// docs/version-resolver.md §"How pooling resolves". Plain loops: the election calls these per remote pair.

// A specifier the tags do not list is still pinned by its package's tag: a flat `core/testing` at 22.0.6 next
// to a build's `core` at 22.0.8 is two cores, whoever lists the entrypoint.
export function agrees(copies: readonly Copy[], tags: SpecifierTags): boolean {
  for (const copy of copies)
    for (const s of copy.specifiers) {
      const tag = tags.tagOf(s);
      if (tag !== undefined && tag !== copy.tag) return false;
    }
  return true;
}

export function serves(
  copies: readonly Copy[],
  tags: SpecifierTags,
  acceptsTag: AcceptsTag
): boolean {
  for (const copy of copies)
    for (const s of copy.specifiers) {
      const tag = tags.get(s);
      if (tag === undefined || !acceptsTag(tag, copy.tag, copy.requiredVersion)) return false;
    }
  return true;
}

// One build must have shipped the combination the copies would run at these tags; a build witnesses its
// packages' other entrypoints at its tag.
export function shippedTogether(
  copies: readonly Copy[],
  tags: SpecifierTags,
  builds: Iterable<Build>
): boolean {
  next: for (const build of builds) {
    for (const copy of copies)
      for (const s of copy.specifiers) if (build.tags.tagOf(s) !== tags.get(s)) continue next;
    return true;
  }
  return false;
}
