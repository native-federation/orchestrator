import type { ExternalName } from './external.contract';
import type { VersionName } from './version.contract';

// An entrypoint as a consumer imports it; pooling keys by it, not by external name (see `pooling/views.ts`).
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

// Tags per specifier that also pin an entrypoint nobody lists: a package is one version, so its tag is the
// root's, else the first entrypoint's — a package can ship entrypoints only (`material/table`, no root).
export class SpecifierTags extends Map<Specifier, VersionName> {
  private readonly packages = new Map<ExternalName, VersionName>();

  constructor(entries: Iterable<readonly [Specifier, VersionName]> = []) {
    super();
    for (const [specifier, tag] of entries) this.set(specifier, tag);
  }

  override set(specifier: Specifier, tag: VersionName): this {
    super.set(specifier, tag);
    const pkg = owningPackage(specifier);
    if (pkg === undefined) this.packages.set(specifier, tag);
    else if (!this.packages.has(pkg)) this.packages.set(pkg, tag);
    return this;
  }

  override clear(): void {
    super.clear();
    this.packages.clear();
  }

  tagOf(specifier: Specifier): VersionName | undefined {
    return this.get(specifier) ?? this.packages.get(owningPackage(specifier) ?? specifier);
  }
}
