import type { DenseSharedInfo, ImportMap, RemoteEntry, SharedExternal } from 'lib/core/1.domain';
import { mockVersionRemote } from '../domain/externals/version.mock';
import { findIncoherentRemotes, findSplitRemotes } from './no-tear';
import { BREAKS, importsFrom, pageFaults, pageTears, resolve } from './page-graph';

const file = (specifier: string) => `${specifier.replace(/\W/g, '_')}.js`;

const info = (
  packageName: string,
  entries: string[],
  { bundle, version = '1.0.0' }: { bundle?: string; version?: string } = {}
): DenseSharedInfo =>
  ({
    packageName,
    version,
    requiredVersion: `^${version}`,
    singleton: true,
    strictVersion: false,
    ...(bundle && { bundle }),
    entries: Object.fromEntries(entries.map(s => [s, file(s)])),
  }) as DenseSharedInfo;

const entry = (
  name: string,
  shared: DenseSharedInfo[],
  chunks?: Record<string, string[]>
): RemoteEntry =>
  ({
    name,
    url: `http://${name}/remoteEntry.json`,
    exposes: [],
    shared,
    ...(chunks && { chunks }),
  }) as unknown as RemoteEntry;

describe('resolve', () => {
  // Import maps: the longest scope prefix of the importing file's URL that maps the specifier wins, then
  // `imports`; the remote that started the chain plays no part.
  it('resolves through the closest referrer', () => {
    const map: ImportMap = {
      imports: { dep: 'http://g/dep.js' },
      scopes: {
        'http://l/': { dep: 'http://l/dep.js', other: 'http://l/other.js' },
        'http://l/sub/': { dep: 'http://s/dep.js' },
      },
    };

    expect(resolve(map, 'dep', 'http://m/x.js')).toBe('http://g/dep.js');
    expect(resolve(map, 'dep', 'http://l/x.js')).toBe('http://l/dep.js');
    expect(resolve(map, 'dep', 'http://l/sub/x.js')).toBe('http://s/dep.js');
    expect(resolve(map, 'other', 'http://l/sub/x.js')).toBe('http://l/other.js');
    expect(resolve(map, 'nope', 'http://l/x.js')).toBeUndefined();
  });

  // The rest of the WHATWG import-map rules no generated map uses yet: package keys ending in `/` map every
  // specifier below them, and a scope key without a trailing `/` matches that one URL only.
  it('resolves trailing-slash keys and exact scope keys as a browser does', () => {
    const map: ImportMap = {
      imports: { 'p/': 'http://g/p/', 'p/deep/': 'http://g/deep/', 'p/x': 'http://g/x.js' },
      scopes: { 'http://l/a.js': { 'p/x': 'http://l/x.js' } },
    };

    expect(resolve(map, 'p/y.js', 'http://m/')).toBe('http://g/p/y.js');
    expect(resolve(map, 'p/deep/z.js', 'http://m/')).toBe('http://g/deep/z.js');
    expect(resolve(map, 'p/x', 'http://m/')).toBe('http://g/x.js');
    expect(resolve(map, 'p/x', 'http://l/a.js')).toBe('http://l/x.js');
    expect(resolve(map, 'p/x', 'http://l/a.jsx')).toBe('http://g/x.js');
  });
});

describe('pageFaults', () => {
  it('passes a page where every remote runs each package from one build', () => {
    const entries = [
      entry('h', [info('p', ['p', 'p/sub'])]),
      entry('r', [info('p', ['p', 'p/sub'])]),
    ];
    const importMap = { imports: { p: 'http://h/p.js', 'p/sub': 'http://h/p_sub.js' } };

    expect(pageFaults({ importMap, entries })).toEqual({});
  });

  // The tag-based oracle (`no-tear.ts`) reads a same-tag mix as coherent, since copies of one version
  // were taken to be interchangeable; two builds of one package are two module instances all the same.
  it('reads a plain unchunked stitch at one tag as stitched, which the tag-based oracle passes', () => {
    const entries = [
      entry('a', [info('m1', ['m1']), info('m1/sub', ['m1/sub'])]),
      entry('b', [info('m1', ['m1', 'm1/sub'])]),
    ];
    const importMap = { imports: { m1: 'http://b/m1.js', 'm1/sub': 'http://a/m1_sub.js' } };
    const share = (...remotes: [string, string[]][]) => ({
      dirty: false,
      versions: [
        {
          tag: '1.0.0',
          host: false,
          action: 'share' as const,
          remotes: remotes.map(([name, entries]) =>
            mockVersionRemote(name, entries[0], {
              entries: Object.fromEntries(entries.map(s => [s, file(s)])),
            })
          ),
        },
      ],
    });
    const members: Record<string, SharedExternal> = {
      m1: share(['a', ['m1']], ['b', ['m1', 'm1/sub']]),
      'm1/sub': share(['a', ['m1/sub']]),
    };
    const scopeUrls = { a: 'http://a/', b: 'http://b/' };

    expect(findIncoherentRemotes({ importMap, members, scopeUrls })).toEqual([]);
    expect(findSplitRemotes({ importMap, members, scopeUrls })).toEqual([]);
    expect(pageFaults({ importMap, entries })).toEqual({
      a: { stitched: ['m1: a b'] },
      b: { stitched: ['m1: a b'] },
    });
    expect(pageFaults({ importMap, entries }, BREAKS)).toEqual({});
  });

  it('reads a stitched chunked package as torn: both builds load their internals', () => {
    const host = entry('h', [info('p', ['p'], { bundle: 'b' })], { b: ['chunk-p.js'] });
    const lender = entry('l', [info('p', ['p', 'p/sub'], { bundle: 'b' })], {
      b: ['chunk-p.js'],
    });
    const importMap = {
      imports: {
        p: 'http://h/p.js',
        'p/sub': 'http://l/p_sub.js',
        '@nf-internal/chunk-p': 'http://h/chunk-p.js',
      },
      scopes: { 'http://l/': { '@nf-internal/chunk-p': 'http://l/chunk-p.js' } },
    };

    expect(pageFaults({ importMap, entries: [host, lender] })).toEqual({
      l: { stitched: ['p: h* l*'], torn: ['p: h l'] },
    });
  });

  it("reads one build's chunk beside another build's unchunked root as torn", () => {
    const host = entry('h', [info('p', ['p'])]);
    const lender = entry('l', [info('p', ['p', 'p/sub'], { bundle: 'b' })], { b: ['chunk-p.js'] });
    const importMap = {
      imports: { p: 'http://h/p.js', 'p/sub': 'http://l/p_sub.js' },
      scopes: { 'http://l/': { '@nf-internal/chunk-p': 'http://l/chunk-p.js' } },
    };

    expect(pageFaults({ importMap, entries: [host, lender] }, BREAKS)).toEqual({
      l: { torn: ['p: h l'] },
    });
  });

  // A borrowed file binds its other imports where it lives, so the host runs the lender's `dep`:
  // two unchunked roots, each carrying its own internals.
  it('reads a dependency resolved through the lender scope as two instances', () => {
    const h = entry('h', [info('p', ['p', 'p/sub']), info('dep', ['dep'])]);
    const l = entry('l', [info('p', ['p', 'p/sub']), info('dep', ['dep'], { version: '2.0.0' })]);
    const importMap = {
      imports: { p: 'http://h/p.js', 'p/sub': 'http://l/p_sub.js', dep: 'http://h/dep.js' },
      scopes: { 'http://l/': { dep: 'http://l/dep.js' } },
    };
    const importsOf = importsFrom({ 'p/sub': ['dep'] });

    expect(pageFaults({ importMap, entries: [h, l], importsOf }, BREAKS)).toEqual({
      h: { torn: ['dep: h l'], twice: ['dep: http://h/dep.js http://l/dep.js'] },
    });
  });

  // An entrypoint served from a build whose chunks the map never maps.
  it('reads an unmapped chunk as unresolved', () => {
    const l = entry('l', [info('p', ['p'], { bundle: 'b' })], { b: ['chunk-b.js'] });

    expect(pageFaults({ importMap: { imports: { p: 'http://l/p.js' } }, entries: [l] })).toEqual({
      l: { unresolved: ['http://l/p.js -> @nf-internal/chunk-b'] },
    });
  });

  it('follows flat chunks of the entrypoint bundle, and an unbundled flat chunk from every file', () => {
    const l = entry('l', [
      info('p', ['p'], { bundle: 'bp' }),
      info('q', ['q'], { bundle: 'bq' }),
      info('@nf-internal/chunk-p', ['@nf-internal/chunk-p'], { bundle: 'bp' }),
      info('@nf-internal/chunk-all', ['@nf-internal/chunk-all']),
    ]);
    const importMap = { imports: { p: 'http://l/p.js', q: 'http://l/q.js' } };

    expect(pageFaults({ importMap, entries: [l] })).toEqual({
      l: {
        unresolved: [
          'http://l/p.js -> @nf-internal/chunk-all',
          'http://l/p.js -> @nf-internal/chunk-p',
          'http://l/q.js -> @nf-internal/chunk-all',
        ],
      },
    });
  });

  it('reads the scope URL from `scopeUrls` when given', () => {
    const r = entry('r', [info('p', ['p'])]);
    const importMap = { imports: { p: 'http://cdn/r/p.js' } };

    expect(pageFaults({ importMap, entries: [r], scopeUrls: { r: 'http://cdn/r/' } })).toEqual({});
    // Without it r's files live at http://r/, so the map's URL is no file r publishes.
    expect(pageFaults({ importMap, entries: [r] })).toEqual({
      r: { unresolved: ['http://r/ -> p'] },
    });
  });

  // The map sends p/sub to a file h does not ship: the page gets a 404 for h's own import and for p's.
  it('reads a mapped URL no build publishes as unresolved', () => {
    const h = entry('h', [info('p', ['p', 'p/sub'])]);
    const importMap = { imports: { p: 'http://h/p.js', 'p/sub': 'http://h/nope.js' } };

    expect(pageFaults({ importMap, entries: [h] })).toEqual({
      h: { unresolved: ['http://h/ -> p/sub', 'http://h/p.js -> p/sub'] },
    });
  });
  // A winner- or consumer-scope leak is a separate defect from a package running from two builds, so
  // specs see it only on request; a leak from a stitched importer stays in.
  it('leaves out a package only a scope leak brings in, unless asked for leaks', () => {
    const w = entry('w', [info('p', ['p']), info('dep', ['dep'], { version: '2.0.0' })]);
    const r = entry('r', [info('p', ['p']), info('dep', ['dep'])]);
    const importMap = {
      imports: { p: 'http://w/p.js', dep: 'http://r/dep.js' },
      scopes: { 'http://w/': { dep: 'http://w/dep.js' } },
    };
    const input = { importMap, entries: [w, r], importsOf: importsFrom({ p: ['dep'] }) };

    expect(pageFaults(input)).toEqual({});
    expect(pageFaults(input, BREAKS, { leaks: true })).toEqual({
      r: { torn: ['dep: r w'], twice: ['dep: http://r/dep.js http://w/dep.js'] },
    });
  });
});

describe('pageTears', () => {
  // A host gap: the host's own file imports an entrypoint nobody maps for it.
  it("reports a host's own unresolved import under the host", () => {
    const h = entry('h', [info('p', ['p'])]);
    const importMap = { imports: { p: 'http://h/p.js' } };
    const importsOf = importsFrom({ p: ['q/sub'] });

    expect(pageTears({ importMap, entries: [h], hosts: ['h'], importsOf })).toEqual([
      { remote: 'h', host: true, unresolved: ['http://h/p.js -> q/sub'], causes: {} },
    ]);
  });

  it('walks a host like any remote and marks it', () => {
    const h = entry('h', [info('p', ['p', 'p/sub'])]);
    const l = entry('l', [info('p', ['p', 'p/sub'])]);
    const importMap = { imports: { p: 'http://h/p.js', 'p/sub': 'http://l/p_sub.js' } };

    expect(pageTears({ importMap, entries: [h, l], hosts: ['h'] })).toEqual([
      { remote: 'h', host: true, stitched: ['p: h l'], causes: { p: ['direct'] } },
      { remote: 'l', host: false, stitched: ['p: h l'], causes: { p: ['direct'] } },
    ]);
  });

  // `r` ships only `p/b` and runs l's; that file imports its sibling `p/a`, which resolves to h's.
  it('names a sibling import from another build', () => {
    const h = entry('h', [info('p', ['p/a'])]);
    const l = entry('l', [info('p', ['p/a', 'p/b'])]);
    const r = entry('r', [info('p', ['p/b'])]);
    const importMap = { imports: { 'p/a': 'http://h/p_a.js', 'p/b': 'http://l/p_b.js' } };

    expect(pageTears({ importMap, entries: [h, l, r] }).find(t => t.remote === 'r')).toEqual({
      remote: 'r',
      host: false,
      stitched: ['p: h l'],
      causes: { p: ['sibling'] },
    });
  });

  it('names a winner-scope leak from a stitched importer', () => {
    const h = entry('h', [info('p', ['p', 'p/sub']), info('dep', ['dep'])]);
    const l = entry('l', [info('p', ['p', 'p/sub']), info('dep', ['dep'], { version: '2.0.0' })]);
    const importMap = {
      imports: { p: 'http://h/p.js', 'p/sub': 'http://l/p_sub.js', dep: 'http://h/dep.js' },
      scopes: { 'http://l/': { dep: 'http://l/dep.js' } },
    };
    const importsOf = importsFrom({ 'p/sub': ['dep'] });

    expect(pageTears({ importMap, entries: [h, l], importsOf })[0]?.causes).toEqual({
      p: ['direct'],
      dep: ['winner-scope-from-stitched'],
    });
  });

  // One build per package, yet the provider's own scope binds a second `dep` for every consumer.
  it('names a winner-scope leak from an unstitched provider', () => {
    const w = entry('w', [info('p', ['p']), info('dep', ['dep'], { version: '2.0.0' })]);
    const r = entry('r', [info('p', ['p']), info('dep', ['dep'])]);
    const importMap = {
      imports: { p: 'http://w/p.js', dep: 'http://r/dep.js' },
      scopes: { 'http://w/': { dep: 'http://w/dep.js' } },
    };
    const importsOf = importsFrom({ p: ['dep'] });

    expect(pageTears({ importMap, entries: [w, r], importsOf })).toEqual([
      {
        remote: 'r',
        host: false,
        stitched: ['dep: r w'],
        torn: ['dep: r w'],
        twice: ['dep: http://r/dep.js http://w/dep.js'],
        causes: { dep: ['winner-scope'] },
      },
    ]);
  });

  // `r` scopes its own `dep`, but the global `p` it runs binds the global one.
  it('names a consumer-scope leak', () => {
    const w = entry('w', [info('p', ['p']), info('dep', ['dep'])]);
    const r = entry('r', [info('p', ['p']), info('dep', ['dep'], { version: '2.0.0' })]);
    const importMap = {
      imports: { p: 'http://w/p.js', dep: 'http://w/dep.js' },
      scopes: { 'http://r/': { dep: 'http://r/dep.js' } },
    };
    const importsOf = importsFrom({ p: ['dep'] });

    expect(pageTears({ importMap, entries: [w, r], importsOf })).toEqual([
      {
        remote: 'r',
        host: false,
        stitched: ['dep: r w'],
        torn: ['dep: r w'],
        twice: ['dep: http://r/dep.js http://w/dep.js'],
        causes: { dep: ['consumer-scope'] },
      },
    ]);
  });
});
