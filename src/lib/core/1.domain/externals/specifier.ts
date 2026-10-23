import type { DeepReadonly } from 'lib/utils/deep-readonly';
import type { ExternalName, shareScope } from './external.contract';
import type { SharedVersionMeta, VersionName } from './version.contract';

// An entrypoint as a consumer imports it; pooling keys by it, not by external name (see `pooling/builds.ts`).
export type Specifier = string;

// The package a secondary entrypoint belongs to, or undefined when the name is already a package.
// An npm package name carries at most one `/` (after a leading `@scope`), so any deeper segment is a
// subpath of the package above it: `@framework/core/testing` -> `@framework/core`, `rxjs/operators`
// -> `rxjs`.
export function owningPackage(name: ExternalName): ExternalName | undefined {
  const depth = name.startsWith('@') ? 2 : 1;
  let cut = -1;
  for (let seen = 0; seen < depth; seen++) {
    cut = name.indexOf('/', cut + 1);
    if (cut === -1) return undefined;
  }
  return name.slice(0, cut);
}

// The package a specifier belongs to in one share scope.
export type PackageOf = (specifier: Specifier) => ExternalName;

const byName: PackageOf = name => owningPackage(name) ?? name;

// A copy and the external it is stored under: a dense copy published that external as its package.
type StoredCopy = readonly [ExternalName, DeepReadonly<SharedVersionMeta>];

// See docs/version-resolver.md §"One build per package". A dense external deeper than an npm name is its own
// package only while every copy shipping it or anything under it is a dense copy of exactly it; otherwise its
// specifiers fall back to the npm name, as a build that bundles them together needs.
export function packageOfIn(
  scope: DeepReadonly<shareScope>,
  loading: readonly StoredCopy[] = []
): PackageOf {
  const candidates = new Set<ExternalName>();
  for (const [name, copy] of copiesIn(scope, loading))
    if (copy.dense && owningPackage(name) !== undefined) candidates.add(name);
  if (candidates.size === 0) return byName;

  const untrusted = new Set<ExternalName>();
  for (const [name, copy] of copiesIn(scope, loading))
    for (const specifier in copy.entries)
      for (const pkg of prefixesOf(specifier))
        if (candidates.has(pkg) && !(copy.dense && name === pkg)) untrusted.add(pkg);
  if (untrusted.size === candidates.size) return byName;

  return specifier => {
    for (const pkg of prefixesOf(specifier))
      if (candidates.has(pkg) && !untrusted.has(pkg)) return pkg;
    return byName(specifier);
  };
}

function* copiesIn(
  scope: DeepReadonly<shareScope>,
  loading: readonly StoredCopy[]
): Generator<StoredCopy> {
  yield* loading;
  for (const [name, external] of Object.entries(scope))
    for (const version of external.versions) for (const copy of version.remotes) yield [name, copy];
}

// The specifier itself first, then each shorter path above it.
function* prefixesOf(specifier: Specifier): Generator<string> {
  for (let cut = specifier.length; cut > 0; cut = specifier.lastIndexOf('/', cut - 1))
    yield specifier.slice(0, cut);
}

// Tags per specifier that also pin an entrypoint nobody lists: a package is one version, so its tag is the
// root's, else the first entrypoint's — a package can ship entrypoints only (`material/table`, no root).
export class SpecifierTags extends Map<Specifier, VersionName> {
  private readonly packages = new Map<ExternalName, VersionName>();

  constructor(
    private readonly packageOf: PackageOf,
    entries: Iterable<readonly [Specifier, VersionName]> = []
  ) {
    super();
    for (const [specifier, tag] of entries) this.set(specifier, tag);
  }

  override set(specifier: Specifier, tag: VersionName): this {
    super.set(specifier, tag);
    const pkg = this.packageOf(specifier);
    if (pkg === specifier || !this.packages.has(pkg)) this.packages.set(pkg, tag);
    return this;
  }

  override clear(): void {
    super.clear();
    this.packages.clear();
  }

  pinnedTag(specifier: Specifier): VersionName | undefined {
    return this.get(specifier) ?? this.packages.get(this.packageOf(specifier));
  }
}

export function groupByPackage<T>(
  items: Iterable<T>,
  nameOf: (item: T) => ExternalName,
  packageOf: PackageOf
): Map<ExternalName, T[]> {
  const packages = new Map<ExternalName, T[]>();
  for (const item of items) {
    const pkg = packageOf(nameOf(item));
    const group = packages.get(pkg);
    if (group) group.push(item);
    else packages.set(pkg, [item]);
  }
  return packages;
}
