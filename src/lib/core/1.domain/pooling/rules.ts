import type { AcceptsTag } from 'lib/core/1.domain/externals/compatibility';
import type { Specifier, SpecifierTags } from 'lib/core/1.domain/externals/specifier';
import type { Build, Copy } from './builds';

// Plain loops: the election calls these per remote pair.
// See docs/version-resolver.md §"How pooling resolves".

// A specifier the tags do not list is still pinned by its package's tag: a flat `core/testing` at 22.0.6 next
// to a build's `core` at 22.0.8 is two cores, whoever lists the entrypoint.
export function agrees(copies: readonly Copy[], tags: SpecifierTags): boolean {
  for (const copy of copies)
    for (const s of copy.specifiers) {
      const tag = tags.pinnedTag(s);
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

// One build must have shipped the combination the copies would run at these tags; a build witnesses
// its packages' other entrypoints at its tag. The gap is the first specifier no build ships next to
// the ones before it.
export function unwitnessedGap(
  copies: readonly Copy[],
  tags: SpecifierTags,
  builds: Iterable<Build>
): Specifier | undefined {
  const specifiers = copies.flatMap(c => c.specifiers);
  let gap = 0;
  for (const build of builds) {
    const miss = specifiers.findIndex(s => build.tags.pinnedTag(s) !== tags.get(s));
    if (miss === -1) return undefined;
    gap = Math.max(gap, miss);
  }
  return specifiers[gap];
}
