import type { Federation, Loaded } from './federation';

/**
 * Coherence measures taken off a *whole* portfolio, where naming every external in an assertion would
 * say less than the shape of the result does. Used by the specs that run the recorded fixtures — 6 to 37
 * shared externals per remote — and by the feature-flag file, which argues about the same portfolios
 * with pooling switched off.
 */

/** The tag every still-shared external is served at, per share scope. */
export const sharedTags = async (nf: Federation, namespace: string) => {
  const tags: Record<string, string> = {};
  for (const [scope, externals] of Object.entries(await nf.store(namespace))) {
    for (const [name, external] of Object.entries(externals)) {
      const shared = external.versions.find(v => v.action === 'share');
      if (shared) tags[scope === '__GLOBAL__' ? name : `${scope}|${name}`] = shared.tag;
    }
  }
  return tags;
};

export const angularTags = async (nf: Federation, namespace: string) =>
  Object.fromEntries(
    Object.entries(await sharedTags(nf, namespace)).filter(([name]) => name.startsWith('@angular/'))
  );

/** The npm package a name belongs to: `@angular/core/primitives/di` → `@angular/core`. */
export const rootOf = (name: string) =>
  name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]!;

/**
 * Externals belonging to one npm package (`@angular/core` and `@angular/core/primitives/di`) that ended
 * up shared at *different* tags. That is the runtime hazard in its purest form: two halves of one
 * package, compiled apart, both live in the same global scope.
 */
export const splitPackages = async (nf: Federation, namespace: string) => {
  const byPackage: Record<string, Set<string>> = {};
  for (const [key, tag] of Object.entries(await sharedTags(nf, namespace))) {
    const name = key.includes('|') ? key.split('|')[1]! : key;
    (byPackage[rootOf(name)] ??= new Set()).add(tag);
  }
  return Object.fromEntries(
    Object.entries(byPackage)
      .filter(([, tags]) => tags.size > 1)
      .map(([pkg, tags]) => [pkg, [...tags].sort()])
  );
};

/**
 * The same coherence question asked of the running page instead of the store: per remote, which minor
 * lines of `@angular/*` did its code actually end up holding? The agreement gate's promise is that this
 * is one line per remote — patch drift inside it is tolerated, a second line is the crash.
 */
export const angularLinesPerRemote = (loaded: Record<string, Loaded>) =>
  Object.fromEntries(
    Object.entries(loaded).map(([name, { seen }]) => [
      name,
      [
        ...new Set(
          Object.values(seen)
            .map(id => /^(.+)\|(.+)@(.+)$/.exec(id))
            .filter((m): m is RegExpExecArray => !!m && m[2]!.startsWith('@angular/'))
            .map(m => m[3]!.split('.').slice(0, 2).join('.'))
        ),
      ].sort(),
    ])
  );
