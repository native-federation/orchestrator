import type { DeepReadonly } from 'lib/utils/deep-readonly';
import { compareStrings } from 'lib/utils/compare-strings';
import { unionFind } from 'lib/utils/union-find';
import type { ExternalName, shareScope } from './external.contract';
import type { SharedVersionMeta, VersionName } from './version.contract';

// An entrypoint as a consumer imports it; pooling keys by it, not by external name (see `pooling/builds.ts`).
export type Specifier = string;

// An npm package name carries at most one `/` (after a leading `@scope`), so any deeper segment is a
// subpath of the package above it: `@framework/core/testing` -> `@framework/core`, `rxjs/operators`
// -> `rxjs`.
export function npmPackageOf(name: ExternalName): ExternalName {
  const depth = name.startsWith('@') ? 2 : 1;
  let cut = -1;
  for (let seen = 0; seen < depth; seen++) {
    cut = name.indexOf('/', cut + 1);
    if (cut === -1) return name;
  }
  return name.slice(0, cut);
}

export type PackageOf = (specifier: Specifier) => ExternalName;

type StoredCopy = readonly [ExternalName, DeepReadonly<SharedVersionMeta>];

// See docs/version-resolver.md §"One build per package".
export function packageOfIn(
  scope: DeepReadonly<shareScope>,
  loading: readonly StoredCopy[] = []
): PackageOf {
  if (!declaresLibrary(scope, loading)) return npmPackageOf;

  // Each root keeps its component's shortest name.
  const { find, union } = unionFind();
  const shortest = new Map<ExternalName, ExternalName>();
  for (const [name, copy] of copiesIn(scope, loading)) {
    const anchor = anchorOf(name, copy);
    for (const specifier in copy.entries) {
      const best = shorter(
        shortest.get(find(anchor)) ?? anchor,
        shortest.get(find(specifier)) ?? specifier
      );
      union(anchor, specifier);
      shortest.set(find(anchor), best);
    }
  }
  // An unlisted specifier joins whatever its npm name joined.
  return specifier => {
    const npm = npmPackageOf(specifier);
    return shortest.get(find(specifier)) ?? shortest.get(find(npm)) ?? npm;
  };
}

const shorter = (a: ExternalName, b: ExternalName): ExternalName =>
  b.length < a.length || (b.length === a.length && compareStrings(b, a) < 0) ? b : a;

function declaresLibrary(scope: DeepReadonly<shareScope>, loading: readonly StoredCopy[]): boolean {
  const isLibrary = (name: ExternalName, copies: readonly DeepReadonly<SharedVersionMeta>[]) =>
    npmPackageOf(name) !== name && copies.some(copy => copy.dense);
  return (
    loading.some(([name, copy]) => isLibrary(name, [copy])) ||
    Object.entries(scope).some(([name, external]) =>
      external.versions.some(version => isLibrary(name, version.remotes))
    )
  );
}

// A flat copy declares no package, so it is at least its npm package.
const anchorOf = (name: ExternalName, copy: DeepReadonly<SharedVersionMeta>): ExternalName =>
  copy.dense ? name : npmPackageOf(name);

function* copiesIn(
  scope: DeepReadonly<shareScope>,
  loading: readonly StoredCopy[]
): Generator<StoredCopy> {
  yield* loading;
  for (const [name, external] of Object.entries(scope))
    for (const version of external.versions) for (const copy of version.remotes) yield [name, copy];
}

// Tags per specifier that also pin the rest of their package: a package is one version, so its tag is the
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
