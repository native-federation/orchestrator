import {
  GLOBAL_SCOPE,
  type ExternalName,
  type ImportMap,
  type RemoteEntry,
  type RemoteName,
} from 'lib/core/1.domain';
import {
  npmPackageOf,
  type PackageOf,
  type Specifier,
} from 'lib/core/1.domain/externals/specifier';
import { compareStrings } from 'lib/utils/compare-strings';
import { toChunkImport } from '@softarc/native-federation/domain';

type Url = string;

// What a build's file imports beyond its own package's entrypoints and chunks, e.g. its framework root.
export type ImportsOf = (build: RemoteName, specifier: Specifier) => Specifier[];

export const importsFrom =
  (deps: Record<Specifier, Specifier[]>): ImportsOf =>
  (_, specifier) =>
    deps[specifier] ?? [];

export type PageInput = {
  importMap: ImportMap;
  // Every remote on the page, as published, dynamic ones included.
  entries: RemoteEntry[];
  // Defaults to the directory of each entry's URL.
  scopeUrls?: Record<RemoteName, Url>;
  hosts?: RemoteName[];
  // Without it a file imports only its own package, so a clean verdict says nothing about cross-package leaks.
  importsOf?: ImportsOf;
};

// `pkg` is undefined for a flat `@nf-internal/` chunk, which carries no one package.
type PageFile = {
  build: RemoteName;
  pkg: Specifier | undefined;
  isChunk: boolean;
  // Its entrypoints import chunks of their build.
  bundleChunked: boolean;
  root: boolean;
  imports: Specifier[];
};

const isInternal = (name: string) => name.startsWith('@nf-internal/');

type ShippedCopy = { packageName: ExternalName; dense?: boolean; specifiers: Specifier[] };

// The package each specifier runs in as its builds bundled it: a dense copy's entries are its `packageName`'s, any
// other copy's the npm name's, and where builds disagree the packages join. Named by its shortest member.
export function packageOfAsShipped(copies: Iterable<ShippedCopy>): PackageOf {
  const parent = new Map<string, string>();
  const find = (name: string): string => {
    const up = parent.get(name);
    if (up === undefined || up === name) return name;
    const root = find(up);
    parent.set(name, root);
    return root;
  };
  const union = (a: string, b: string) => {
    for (const name of [a, b]) if (!parent.has(name)) parent.set(name, name);
    const [x, y] = [find(a), find(b)];
    if (x === y) return;
    const keepX = x.length < y.length || (x.length === y.length && compareStrings(x, y) < 0);
    if (keepX) parent.set(y, x);
    else parent.set(x, y);
  };
  for (const { packageName, dense, specifiers } of copies)
    for (const specifier of specifiers)
      union(specifier, dense ? packageName : npmPackageOf(specifier));
  return specifier => find(parent.has(specifier) ? specifier : npmPackageOf(specifier));
}

// Every file the entries publish, by URL, and per remote where its own code lives and what it imports.
function indexPage({ entries, scopeUrls = {}, importsOf = () => [] }: PageInput) {
  const files = new Map<Url, PageFile>();
  const remotes = new Map<RemoteName, { scopeUrl: Url; ships: Specifier[] }>();
  const shippedIn = new Map<string, ShippedCopy[]>();
  for (const entry of entries)
    for (const info of entry.shared) {
      if (isInternal(info.packageName)) continue;
      const scope = info.shareScope ?? GLOBAL_SCOPE;
      const copies = shippedIn.get(scope) ?? shippedIn.set(scope, []).get(scope)!;
      copies.push({
        packageName: info.packageName,
        dense: info.dense,
        specifiers: Object.keys(info.entries),
      });
    }
  const packageOfByScope = new Map(
    [...shippedIn].map(([scope, copies]) => [scope, packageOfAsShipped(copies)])
  );
  for (const entry of entries) {
    const scopeUrl = scopeUrls[entry.name] ?? new URL('./', entry.url).href;
    const at = (file: string) => new URL(file, scopeUrl).href;
    const flat = entry.shared.filter(info => isInternal(info.packageName));
    const shared = entry.shared.filter(info => !isInternal(info.packageName));
    const ships = shared.flatMap(info => Object.keys(info.entries));
    for (const info of shared) {
      const packageOf = packageOfByScope.get(info.shareScope ?? GLOBAL_SCOPE)!;
      const bundleChunks = (info.bundle && entry.chunks?.[info.bundle]) || [];
      // A flat chunk without a bundle is read as imported by every file of its build.
      const chunks = [
        ...bundleChunks.map(toChunkImport),
        ...flat
          .filter(chunk => chunk.bundle === undefined || chunk.bundle === info.bundle)
          .flatMap(chunk => Object.keys(chunk.entries)),
      ];
      const bundleChunked = chunks.length > 0;
      for (const [specifier, file] of Object.entries(info.entries)) {
        const pkg = packageOf(specifier);
        // Which siblings it really imports is unknown, so every one its build ships counts; a root the build
        // does not share is bundled into the entrypoint, not imported.
        const imports = [
          ...ships.filter(sibling => sibling !== specifier && packageOf(sibling) === pkg),
          ...importsOf(entry.name, specifier),
        ];
        const root = info.dense
          ? specifier === info.packageName
          : npmPackageOf(specifier) === specifier;
        files.set(at(file), {
          build: entry.name,
          pkg,
          isChunk: false,
          bundleChunked,
          root,
          imports: [...imports, ...chunks],
        });
        // A chunk holds the package's internals, so it imports what its entrypoints import.
        for (const chunk of bundleChunks)
          files.set(at(chunk), {
            build: entry.name,
            pkg,
            isChunk: true,
            bundleChunked,
            root: false,
            imports,
          });
      }
    }
    for (const chunk of flat)
      for (const file of Object.values(chunk.entries))
        files.set(at(file), {
          build: entry.name,
          pkg: undefined,
          isChunk: true,
          bundleChunked: true,
          root: false,
          imports: [],
        });
    remotes.set(entry.name, { scopeUrl, ships });
  }
  return { files, remotes };
}

type Hit = { url: Url; scoped: boolean };

// An exact key, else the longest `/`-terminated key prefixing the specifier, with the rest appended.
function lookup(specifierMap: Record<Specifier, Url>, specifier: Specifier): Url | undefined {
  const exact = specifierMap[specifier];
  if (exact !== undefined) return exact;
  const prefix = Object.keys(specifierMap)
    .filter(key => key.endsWith('/') && specifier.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return prefix === undefined ? undefined : specifierMap[prefix] + specifier.slice(prefix.length);
}

// The browser's closest-referrer rule: the scopes matching the importing file's URL, longest first, then
// `imports`.
export function resolverOf(importMap: ImportMap) {
  const scopes = Object.keys(importMap.scopes ?? {}).sort((a, b) => b.length - a.length);
  return (specifier: Specifier, referrer: Url): Hit | undefined => {
    for (const scope of scopes) {
      if (scope !== referrer && !(scope.endsWith('/') && referrer.startsWith(scope))) continue;
      const url = lookup(importMap.scopes![scope]!, specifier);
      if (url !== undefined) return { url, scoped: true };
    }
    const url = lookup(importMap.imports, specifier);
    return url === undefined ? undefined : { url, scoped: false };
  };
}

export const resolve = (importMap: ImportMap, specifier: Specifier, referrer: Url) =>
  resolverOf(importMap)(specifier, referrer)?.url;

// One resolved import: `via` is the importing file, undefined for the remote's own code.
type Edge = {
  specifier: Specifier;
  hit: Hit;
  file: PageFile | undefined;
  via: PageFile | undefined;
};

// Everything `remote`'s page loads: its own specifiers from its scope URL, then each reached file's imports
// from that file's own URL.
function walk(
  remote: RemoteName,
  page: ReturnType<typeof indexPage>,
  resolveHit: ReturnType<typeof resolverOf>
) {
  const { scopeUrl, ships } = page.remotes.get(remote)!;
  const edges: Edge[] = [];
  const unresolved = new Set<string>();
  const seen = new Set<Url>();
  const queue: Url[] = [];
  const reach = (specifier: Specifier, referrer: Url, via: PageFile | undefined) => {
    const hit = resolveHit(specifier, referrer);
    // A URL no build publishes is a 404 on the page, as much as a specifier the map lacks.
    if (hit === undefined || !page.files.has(hit.url))
      return void unresolved.add(`${referrer} -> ${specifier}`);
    edges.push({ specifier, hit, file: page.files.get(hit.url), via });
    if (seen.has(hit.url)) return;
    seen.add(hit.url);
    queue.push(hit.url);
  };
  for (const specifier of ships) reach(specifier, scopeUrl, undefined);
  while (queue.length > 0) {
    const url = queue.shift()!;
    const file = page.files.get(url);
    for (const specifier of file?.imports ?? []) reach(specifier, url, file);
  }
  return { edges, unresolved: [...unresolved].sort() };
}

/**
 * Per remote, what its page runs:
 * - `stitched`: a package whose files come from more than one build (a chunked build marked `*`): the rule
 *   "one build per package per remote";
 * - `torn`: a package whose internals load from more than one build: two builds' chunks, or one build's chunk
 *   beside another build's unchunked root;
 * - `twice`: a specifier resolving to more than one URL, two module instances;
 * - `unresolved`: `<referrer> -> <specifier>`, an import the map cannot resolve from where the referrer lives.
 */
export type PageFault = 'stitched' | 'torn' | 'twice' | 'unresolved';
export type PageFaults = Partial<Record<PageFault, string[]>>;

// What breaks a page whatever the stitching policy; `stitched` alone breaks only the one-build-per-package rule.
export const BREAKS: PageFault[] = ['unresolved', 'twice', 'torn'];

export type PageTear = PageFaults & {
  remote: RemoteName;
  host: boolean;
  // Per stitched package, how its other builds got in: `direct` (the remote's own specifiers already resolve
  // to two builds), `sibling` (an entrypoint from another build imports its siblings through its own URL),
  // `winner-scope` / `consumer-scope` (another package's file binds it through its own scope / through
  // `imports`), suffixed `-from-stitched` when that importer is itself stitched.
  causes: Record<Specifier, string[]>;
};

// Per package, per build the walk reaches: whether it is chunked, and every edge that reached it.
type Builds = Map<Specifier, Map<RemoteName, { bundleChunked: boolean; reaches: Reach[] }>>;

// `remote`'s walk counted per package (builds reached, builds whose internals load) and per specifier (URLs).
function tally(
  remote: RemoteName,
  page: ReturnType<typeof indexPage>,
  resolveHit: ReturnType<typeof resolverOf>
) {
  const { edges, unresolved } = walk(remote, page, resolveHit);
  const urls = new Map<Specifier, Set<Url>>();
  // The package a specifier's files are in: a file's own share scope decides it, so it is read off the file.
  const packages = new Map<Specifier, Specifier>();
  const internals = new Map<Specifier, Set<RemoteName>>();
  const builds: Builds = new Map();
  for (const { specifier, hit, file, via } of edges) {
    if (!isInternal(specifier)) add(urls, specifier, hit.url);
    if (file?.pkg !== undefined && !packages.has(specifier)) packages.set(specifier, file.pkg);
    if (file?.isChunk && via?.pkg !== undefined && !via.isChunk)
      add(internals, via.pkg, file.build);
    if (file?.pkg === undefined || file.isChunk) continue;
    if (file.root && !file.bundleChunked) add(internals, file.pkg, file.build);
    let byBuild = builds.get(file.pkg);
    if (!byBuild) builds.set(file.pkg, (byBuild = new Map()));
    let build = byBuild.get(file.build);
    if (!build)
      byBuild.set(file.build, (build = { bundleChunked: file.bundleChunked, reaches: [] }));
    build.reaches.push(reachOf(file, via, hit));
  }
  return { builds, internals, urls, packages, unresolved };
}

// The faults of one tally, leaving out the packages in `skip`.
function faultsOf(
  { builds, internals, urls, packages, unresolved }: ReturnType<typeof tally>,
  skip = new Set<Specifier>()
): PageFaults {
  const stitched = new Map(
    [...builds]
      .filter(([pkg]) => !skip.has(pkg))
      .map(([pkg, byBuild]) => [
        pkg,
        new Set(
          [...byBuild].map(([build, { bundleChunked }]) => (bundleChunked ? `${build}*` : build))
        ),
      ])
  );
  return nonEmpty({
    stitched: listed(stitched),
    torn: listed(internals, pkg => !skip.has(pkg)),
    twice: listed(urls, specifier => !skip.has(packages.get(specifier) ?? npmPackageOf(specifier))),
    unresolved,
  });
}

/**
 * The page-wide oracle: per remote (hosts included), every file its own code reaches, following each file's
 * imports from where that file lives across packages, chunks and pools. Lists only remotes with a fault.
 */
export function pageTears(input: PageInput): PageTear[] {
  const page = indexPage(input);
  const resolveHit = resolverOf(input.importMap);
  const hosts = new Set(input.hosts);
  return [...page.remotes.keys()].flatMap(remote => {
    const counted = tally(remote, page, resolveHit);
    const faults = faultsOf(counted);
    if (Object.keys(faults).length === 0) return [];
    const causes = Object.fromEntries(causesOf(counted.builds));
    return [{ remote, host: hosts.has(remote), ...faults, causes }];
  });
}

const LEAKS: string[] = ['winner-scope', 'consumer-scope'];

// By default a package that only a winner- or consumer-scope leak brings in is left out: that leak is a
// separate defect from a package running from two builds.
export function pageFaults(
  input: PageInput,
  kinds: PageFault[] = [...BREAKS, 'stitched'],
  { leaks = false }: { leaks?: boolean } = {}
): Record<RemoteName, PageFaults> {
  const page = indexPage(input);
  const resolveHit = resolverOf(input.importMap);
  const out: Record<RemoteName, PageFaults> = {};
  for (const remote of page.remotes.keys()) {
    const counted = tally(remote, page, resolveHit);
    const leakOnly = leaks
      ? []
      : [...causesOf(counted.builds)]
          .filter(([, causes]) => causes.every(cause => LEAKS.includes(cause)))
          .map(([pkg]) => pkg);
    const faults = faultsOf(counted, new Set(leakOnly));
    const kept = nonEmpty(Object.fromEntries(kinds.map(kind => [kind, faults[kind] ?? []])));
    if (Object.keys(kept).length > 0) out[remote] = kept;
  }
  return out;
}

type Reach = {
  how: 'direct' | 'sibling' | 'winner-scope' | 'consumer-scope';
  importer?: Specifier;
};

function reachOf(file: PageFile, via: PageFile | undefined, hit: Hit): Reach {
  if (via === undefined) return { how: 'direct' };
  if (via.pkg === file.pkg) return { how: 'sibling' };
  return { how: hit.scoped ? 'winner-scope' : 'consumer-scope', importer: via.pkg };
}

// Per stitched package, how its builds got in.
function causesOf(builds: Builds): Map<Specifier, string[]> {
  const stitched = new Set(
    [...builds].filter(([, byBuild]) => byBuild.size > 1).map(([pkg]) => pkg)
  );
  const isDirect = (build: { reaches: Reach[] }) => build.reaches.some(r => r.how === 'direct');
  const out = new Map<Specifier, string[]>();
  for (const pkg of stitched) {
    const byBuild = [...builds.get(pkg)!.values()];
    const causes: string[] = byBuild.filter(isDirect).length > 1 ? ['direct'] : [];
    // Only a build the remote's own code does not reach says how it got in.
    for (const build of byBuild.filter(build => !isDirect(build)))
      for (const { how, importer } of build.reaches)
        causes.push(
          importer !== undefined && stitched.has(importer) ? `${how}-from-stitched` : how
        );
    out.set(pkg, [...new Set(causes)].sort());
  }
  return out;
}

// `<key>: <values>` for every kept key with more than one value, sorted.
const listed = (map: Map<string, Set<string>>, keep: (key: string) => boolean = () => true) =>
  [...map]
    .filter(([key, values]) => values.size > 1 && keep(key))
    .map(([key, values]) => `${key}: ${[...values].sort().join(' ')}`)
    .sort();

const nonEmpty = (faults: PageFaults): PageFaults =>
  Object.fromEntries(Object.entries(faults).filter(([, list]) => list.length > 0));

const add = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
};
