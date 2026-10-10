import type { SharedExternal } from 'lib/core/1.domain';
import { mockVersionRemote } from '../domain/externals/version.mock';
import { emittedUrls, findIncoherentRemotes, findSplitRemotes, tearsByPool } from './no-tear';

/**
 * The guard's own test. A checker that cannot fail is worse than no checker, so the torn case comes
 * first: `findIncoherentRemotes` is only load-bearing for I3 if it catches a combination no build
 * shipped.
 */
describe('findIncoherentRemotes', () => {
  const SCOPE = {
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
  } as const;

  // mfe-a ships the whole family at 22.1.0; mfe-b ships only core, at 22.0.5.
  const members = (): Record<string, SharedExternal> => ({
    '@angular/core': {
      dirty: false,
      versions: [
        {
          tag: '22.0.5',
          host: false,
          action: 'share',
          remotes: [
            mockVersionRemote('team/mfe-b', '@angular/core', { requiredVersion: '~22.0.5' }),
          ],
        },
        {
          tag: '22.1.0',
          host: false,
          action: 'skip',
          remotes: [
            mockVersionRemote('team/mfe-a', '@angular/core', { requiredVersion: '^22.0.0' }),
          ],
        },
      ],
    },
    '@angular/router': {
      dirty: false,
      versions: [
        {
          tag: '22.1.0',
          host: false,
          action: 'share',
          remotes: [
            mockVersionRemote('team/mfe-a', '@angular/router', { requiredVersion: '^22.0.0' }),
          ],
        },
      ],
    },
  });

  it('catches a remote whose resolved tags no build shipped together', () => {
    // mfe-a would run core@22.0.5 from mfe-b beside its own router@22.1.0. Nobody built that pair.
    const incoherent = findIncoherentRemotes({
      importMap: {
        imports: {
          '@angular/core': 'http://mfe-b/@angular/core.js',
          '@angular/router': 'http://mfe-a/@angular/router.js',
        },
      },
      members: members(),
      scopeUrls: SCOPE,
    });

    expect(incoherent).toEqual([
      {
        remote: 'team/mfe-a',
        resolved: { '@angular/core': '22.0.5', '@angular/router': '22.1.0' },
        closest: expect.objectContaining({ matched: 1, of: 2 }),
      },
    ]);
  });

  it('accepts the same portfolio once the island puts mfe-a back on its own build', () => {
    const incoherent = findIncoherentRemotes({
      importMap: {
        imports: { '@angular/core': 'http://mfe-b/@angular/core.js' },
        scopes: {
          'http://mfe-a/': {
            '@angular/core': 'http://mfe-a/@angular/core.js',
            '@angular/router': 'http://mfe-a/@angular/router.js',
          },
        },
      },
      members: members(),
      scopeUrls: SCOPE,
    });

    expect(incoherent).toEqual([]);
  });

  // The coherent map above, but mfe-a's router points at a file no member copy emits: a file outside the
  // pool, whose tag nobody can know, so no build witnesses it.
  it('catches a pooled specifier mapped to a file no member copy emits', () => {
    const incoherent = findIncoherentRemotes({
      importMap: {
        imports: { '@angular/core': 'http://mfe-b/@angular/core.js' },
        scopes: {
          'http://mfe-a/': {
            '@angular/core': 'http://mfe-a/@angular/core.js',
            '@angular/router': 'http://elsewhere/@angular/router.js',
          },
        },
      },
      members: members(),
      scopeUrls: SCOPE,
    });

    expect(incoherent).toEqual([
      expect.objectContaining({
        remote: 'team/mfe-a',
        resolved: { '@angular/core': '22.1.0', '@angular/router': '<untaggable>' },
      }),
    ]);
  });

  // Origin is free, tag is not: mfe-a taking core from a *different* remote that ships the same tag
  // is interchangeable, so it must not register as incoherent (I3 is per version).
  it('does not mind which remote served a tag, only which tag', () => {
    const record = members();
    // A second provider of mfe-a's own tag, so the global mapping can serve core from mfe-c instead.
    record['@angular/core']!.versions[1]!.remotes.push(
      mockVersionRemote('team/mfe-c', '@angular/core', { requiredVersion: '^22.0.0' })
    );

    const incoherent = findIncoherentRemotes({
      importMap: {
        imports: {
          '@angular/core': 'http://mfe-c/@angular/core.js',
          '@angular/router': 'http://mfe-a/@angular/router.js',
        },
      },
      members: record,
      scopeUrls: { ...SCOPE, 'team/mfe-c': 'http://mfe-c/' },
    });

    expect(incoherent).toEqual([]);
  });

  it('exempts host remotes', () => {
    const incoherent = findIncoherentRemotes({
      importMap: {
        imports: {
          '@angular/core': 'http://mfe-b/@angular/core.js',
          '@angular/router': 'http://mfe-a/@angular/router.js',
        },
      },
      members: members(),
      scopeUrls: SCOPE,
      hosts: ['team/mfe-a'],
    });

    expect(incoherent).toEqual([]);
  });

  // A build ships each package at one tag whichever entrypoints it lists, so one entrypoint at a tag witnesses
  // the package's root and its other entrypoints at that tag too. mfe-c consumes core and router at 18.0.0
  // and resolves core@18.0.1 from mfe-b and router@18.0.1 from mfe-w; the question is whether mfe-w's build
  // witnesses core@18.0.1 although it lists a different entrypoint of core than the one served.
  describe('package-level witnesses', () => {
    const SCOPES = {
      'team/mfe-b': 'http://mfe-b/',
      'team/mfe-c': 'http://mfe-c/',
      'team/mfe-w': 'http://mfe-w/',
    };
    const copy = (remote: string, external: string, entries: string[]) => ({
      ...mockVersionRemote(remote, external, { requiredVersion: '^18.0.0' }),
      entries: Object.fromEntries(entries.map(e => [e, `${e}.js`])),
    });
    const record = (witness: { tag: string; core: string[] }): Record<string, SharedExternal> => ({
      '@angular/core': {
        dirty: false,
        versions: [
          ...(witness.tag === '18.0.1'
            ? []
            : [
                {
                  tag: witness.tag,
                  host: false,
                  action: 'skip' as const,
                  remotes: [copy('team/mfe-w', '@angular/core', witness.core)],
                },
              ]),
          {
            tag: '18.0.1',
            host: false,
            action: 'share',
            remotes: [
              copy('team/mfe-b', '@angular/core', ['@angular/core']),
              ...(witness.tag === '18.0.1'
                ? [copy('team/mfe-w', '@angular/core', witness.core)]
                : []),
            ],
          },
          {
            tag: '18.0.0',
            host: false,
            action: 'skip',
            remotes: [
              copy('team/mfe-c', '@angular/core', ['@angular/core', '@angular/core/testing']),
            ],
          },
        ],
      },
      '@angular/router': {
        dirty: false,
        versions: [
          {
            tag: '18.0.1',
            host: false,
            action: 'share',
            remotes: [copy('team/mfe-w', '@angular/router', ['@angular/router'])],
          },
          {
            tag: '18.0.0',
            host: false,
            action: 'skip',
            remotes: [copy('team/mfe-c', '@angular/router', ['@angular/router'])],
          },
        ],
      },
    });
    const importMap = (testing: string) => ({
      imports: {
        '@angular/core': 'http://mfe-b/@angular/core.js',
        '@angular/core/testing': testing,
        '@angular/router': 'http://mfe-w/@angular/router.js',
      },
    });
    const torn = (witness: { tag: string; core: string[] }, testing: string) =>
      findIncoherentRemotes({
        importMap: importMap(testing),
        members: record(witness),
        scopeUrls: SCOPES,
      }).map(i => i.remote);

    it('counts a build shipping only a secondary entrypoint as shipping its root at that tag', () => {
      // mfe-w lists only core/testing@18.0.1, which mfe-c also resolves from it: core@18.0.1 is witnessed.
      expect(
        torn(
          { tag: '18.0.1', core: ['@angular/core/testing'] },
          'http://mfe-w/@angular/core/testing.js'
        )
      ).toEqual([]);
    });

    it('counts a build shipping the root as shipping its secondary entrypoints at that tag', () => {
      // mfe-w lists only the core root, yet witnesses the core/testing@18.0.1 mfe-c takes from mfe-b's tag.
      const members = record({ tag: '18.0.1', core: ['@angular/core'] });
      members['@angular/core']!.versions[0]!.remotes[0]!.entries['@angular/core/testing'] =
        '@angular/core/testing.js';
      expect(
        findIncoherentRemotes({
          importMap: importMap('http://mfe-b/@angular/core/testing.js'),
          members,
          scopeUrls: SCOPES,
        }).map(i => i.remote)
      ).toEqual([]);
    });

    it('still flags the pairing when the entrypoint the build lists is at another tag', () => {
      // mfe-w ships core/testing at 18.0.0, so no build shipped core@18.0.1 beside router@18.0.1.
      expect(
        torn(
          { tag: '18.0.0', core: ['@angular/core/testing'] },
          'http://mfe-c/@angular/core/testing.js'
        )
      ).toContain('team/mfe-c');
    });
  });

  it('counts every file the map can fetch, deduped', () => {
    expect(
      emittedUrls({
        imports: { a: 'http://x/a.js', b: 'http://x/b.js' },
        scopes: { 'http://y/': { a: 'http://y/a.js', b: 'http://x/b.js' } },
      })
    ).toEqual(new Set(['http://x/a.js', 'http://x/b.js', 'http://y/a.js']));
  });
});

/**
 * The second hop. Every case here resolves a coherent set *directly*, so `findIncoherentRemotes` passes all
 * of them; what differs is what the served files bind one import further in.
 */
describe('findSplitRemotes', () => {
  const SCOPE = {
    'team/mfe-a': 'http://mfe-a/',
    'team/mfe-b': 'http://mfe-b/',
  } as const;

  const copy = (tag: string, action: 'share' | 'skip' | 'scope', remote: string, name: string) => ({
    tag,
    host: false,
    action,
    remotes: [mockVersionRemote(remote, name, { requiredVersion: '^22.0.0' })],
  });

  // mfe-b is the global build at core@22.0.8 + material@22.0.6; mfe-a ships core@22.0.6 + material@22.0.6.
  const members = (): Record<string, SharedExternal> => ({
    '@angular/core': {
      dirty: false,
      versions: [
        copy('22.0.8', 'share', 'team/mfe-b', '@angular/core'),
        copy('22.0.6', 'scope', 'team/mfe-a', '@angular/core'),
      ],
    },
    '@angular/material': {
      dirty: false,
      versions: [
        {
          ...copy('22.0.6', 'share', 'team/mfe-b', '@angular/material'),
          remotes: [
            mockVersionRemote('team/mfe-b', '@angular/material', { requiredVersion: '^22.0.0' }),
            mockVersionRemote('team/mfe-a', '@angular/material', { requiredVersion: '^22.0.0' }),
          ],
        },
      ],
    },
  });

  it('catches a remote taking a same-tag global file that binds a foreign peer', () => {
    // mfe-a keeps its own core but takes the global material@22.0.6 — the same tag it shipped. That file
    // lives at mfe-b, so its `@angular/core` import resolves globally to 22.0.8: two cores in mfe-a.
    const importMap = {
      imports: {
        '@angular/core': 'http://mfe-b/@angular/core.js',
        '@angular/material': 'http://mfe-b/@angular/material.js',
      },
      scopes: { 'http://mfe-a/': { '@angular/core': 'http://mfe-a/@angular/core.js' } },
    };

    expect(findIncoherentRemotes({ importMap, members: members(), scopeUrls: SCOPE })).toEqual([]);
    expect(findSplitRemotes({ importMap, members: members(), scopeUrls: SCOPE })).toEqual([
      { remote: 'team/mfe-a', specifiers: { '@angular/core': ['22.0.6', '22.0.8'] } },
    ]);
  });

  it('catches two entrypoints of one package at different tags, though each specifier has one', () => {
    // Material ships entrypoints only. mfe-b's `/table@22.0.6` is global, and mfe-a's `/sort@22.0.8` is
    // self-filled from mfe-a beside it. Each specifier resolves to one tag, but mfe-a reaches mfe-b's table
    // one hop in (through the global core mfe-b ships): two Material builds — review finding F1's outcome.
    const entrypoint = (remote: string, tag: string, specifier: string) => ({
      tag,
      host: false,
      action: 'share' as const,
      remotes: [
        mockVersionRemote(remote, '@angular/material', {
          requiredVersion: '^22.0.0',
          entries: { [specifier]: `${specifier}.js` },
        }),
      ],
    });
    const torn: Record<string, SharedExternal> = {
      '@angular/core': {
        dirty: false,
        versions: [
          {
            ...copy('22.0.8', 'share', 'team/mfe-b', '@angular/core'),
            remotes: [
              mockVersionRemote('team/mfe-b', '@angular/core', { requiredVersion: '^22.0.0' }),
              mockVersionRemote('team/mfe-a', '@angular/core', { requiredVersion: '^22.0.0' }),
            ],
          },
        ],
      },
      '@angular/material': {
        dirty: false,
        versions: [
          entrypoint('team/mfe-a', '22.0.8', '@angular/material/sort'),
          entrypoint('team/mfe-b', '22.0.6', '@angular/material/table'),
        ],
      },
    };
    const importMap = {
      imports: {
        '@angular/core': 'http://mfe-b/@angular/core.js',
        '@angular/material/table': 'http://mfe-b/@angular/material/table.js',
        '@angular/material/sort': 'http://mfe-a/@angular/material/sort.js',
      },
    };

    expect(findSplitRemotes({ importMap, members: torn, scopeUrls: SCOPE })).toEqual([
      { remote: 'team/mfe-a', specifiers: { '@angular/material': ['22.0.6', '22.0.8'] } },
    ]);
  });

  it('accepts the remote once it serves its whole family itself', () => {
    const importMap = {
      imports: {
        '@angular/core': 'http://mfe-b/@angular/core.js',
        '@angular/material': 'http://mfe-b/@angular/material.js',
      },
      scopes: {
        'http://mfe-a/': {
          '@angular/core': 'http://mfe-a/@angular/core.js',
          '@angular/material': 'http://mfe-a/@angular/material.js',
        },
      },
    };

    expect(findSplitRemotes({ importMap, members: members(), scopeUrls: SCOPE })).toEqual([]);
  });

  it("accepts a remote run in a subpool whose build's scope maps its own family", () => {
    // mfe-a dedups everything onto mfe-c's 22.0.6 build; mfe-c's own scope keeps that build's files bound
    // to each other, so the walk from mfe-a never leaves 22.0.6.
    const record = members();
    record['@angular/core']!.versions[1]!.remotes.push(
      mockVersionRemote('team/mfe-c', '@angular/core', { requiredVersion: '^22.0.0' })
    );
    record['@angular/material']!.versions[0]!.remotes.push(
      mockVersionRemote('team/mfe-c', '@angular/material', { requiredVersion: '^22.0.0' })
    );
    const importMap = {
      imports: {
        '@angular/core': 'http://mfe-b/@angular/core.js',
        '@angular/material': 'http://mfe-b/@angular/material.js',
      },
      scopes: {
        'http://mfe-a/': {
          '@angular/core': 'http://mfe-c/@angular/core.js',
          '@angular/material': 'http://mfe-c/@angular/material.js',
        },
        'http://mfe-c/': {
          '@angular/core': 'http://mfe-c/@angular/core.js',
          '@angular/material': 'http://mfe-c/@angular/material.js',
        },
      },
    };

    expect(
      findSplitRemotes({
        importMap,
        members: record,
        scopeUrls: { ...SCOPE, 'team/mfe-c': 'http://mfe-c/' },
      })
    ).toEqual([]);
  });

  it('exempts host remotes', () => {
    const importMap = {
      imports: {
        '@angular/core': 'http://mfe-b/@angular/core.js',
        '@angular/material': 'http://mfe-b/@angular/material.js',
      },
      scopes: { 'http://mfe-a/': { '@angular/core': 'http://mfe-a/@angular/core.js' } },
    };

    expect(
      findSplitRemotes({ importMap, members: members(), scopeUrls: SCOPE, hosts: ['team/mfe-a'] })
    ).toEqual([]);
  });
});

describe('tearsByPool', () => {
  const SCOPE = { 'team/mfe-a': 'http://mfe-a/', 'team/mfe-b': 'http://mfe-b/' };

  // One stored external: per version, its tag and the copies shipping it, each with the specifiers it lists.
  const external = (
    poolName: string | undefined,
    versions: [tag: string, copies: [remote: string, specifiers: string[]][]][]
  ): SharedExternal => ({
    dirty: false,
    ...(poolName === undefined ? {} : { poolName }),
    versions: versions.map(([tag, copies]) => ({
      tag,
      host: false,
      action: 'skip',
      remotes: copies.map(([remote, specifiers]) => ({
        ...mockVersionRemote(remote, specifiers[0]!, { requiredVersion: `^${tag}` }),
        entries: Object.fromEntries(specifiers.map(s => [s, `${s}.js`])),
      })),
    })),
  });

  // mfe-a ships the fw pool at 2.0.0, mfe-b only core at 1.0.0; the map hands mfe-a core@1.0.0 beside its own
  // router@2.0.0. The ds pool is served wholly from mfe-b, and the flat package `lib` is split across builds.
  const externals = () => ({
    __GLOBAL__: {
      '@fw/core': external('fw', [
        ['2.0.0', [['team/mfe-a', ['@fw/core']]]],
        ['1.0.0', [['team/mfe-b', ['@fw/core']]]],
      ]),
      '@fw/router': external('fw', [['2.0.0', [['team/mfe-a', ['@fw/router']]]]]),
      '@ds/kit': external('ds', [
        ['4.0.0', [['team/mfe-b', ['@ds/kit']]]],
        ['3.0.0', [['team/mfe-a', ['@ds/kit']]]],
      ]),
      '@ds/icons': external('ds', [['4.0.0', [['team/mfe-b', ['@ds/icons']]]]]),
      lib: external(undefined, [
        ['1.1.0', [['team/mfe-b', ['lib']]]],
        ['1.0.0', [['team/mfe-a', ['lib']]]],
      ]),
      'lib/sub': external(undefined, [['1.0.0', [['team/mfe-a', ['lib/sub']]]]]),
    },
  });

  const importMap = {
    imports: {
      '@fw/core': 'http://mfe-b/@fw/core.js',
      '@fw/router': 'http://mfe-a/@fw/router.js',
      '@ds/kit': 'http://mfe-b/@ds/kit.js',
      '@ds/icons': 'http://mfe-b/@ds/icons.js',
      lib: 'http://mfe-b/lib.js',
      'lib/sub': 'http://mfe-a/lib/sub.js',
    },
  };

  it('reports each torn group once, named by share scope and pool, and leaves coherent pools out', () => {
    const tears = tearsByPool({ importMap, externals: externals(), scopeUrls: SCOPE });
    expect(tears.map(t => t.pool).sort()).toEqual(['__GLOBAL__|fw', '__GLOBAL__|package:lib']);
    expect(tears.find(t => t.pool === '__GLOBAL__|fw')!.incoherent).toEqual([
      expect.objectContaining({
        remote: 'team/mfe-a',
        resolved: { '@fw/core': '1.0.0', '@fw/router': '2.0.0' },
      }),
    ]);
  });

  it('judges one pool at a time: a remote on another build per pool is no tear', () => {
    // mfe-a runs ds@4.0.0 from mfe-b beside fw from wherever: across pools nothing is promised.
    const coherentFw = { ...importMap.imports, '@fw/core': 'http://mfe-a/@fw/core.js' };
    expect(
      tearsByPool({
        importMap: { imports: coherentFw },
        externals: externals(),
        scopeUrls: SCOPE,
      }).map(t => t.pool)
    ).toEqual(['__GLOBAL__|package:lib']);
  });

  it('groups the flat externals of one unpooled package, which alone would each look coherent', () => {
    // `lib@1.1.0` and `lib/sub@1.0.0` are two builds of one package; judged per external name, neither tears.
    const lib = tearsByPool({ importMap, externals: externals(), scopeUrls: SCOPE }).find(
      t => t.pool === '__GLOBAL__|package:lib'
    )!;
    expect(lib.incoherent.map(i => i.remote)).toEqual(['team/mfe-a']);
    expect(
      findIncoherentRemotes({
        importMap,
        members: { lib: externals().__GLOBAL__.lib },
        scopeUrls: SCOPE,
      })
    ).toEqual([]);
  });

  it('exempts hosts', () => {
    expect(
      tearsByPool({ importMap, externals: externals(), scopeUrls: SCOPE, hosts: ['team/mfe-a'] })
    ).toEqual([]);
  });

  it('keeps share scopes apart', () => {
    const tears = tearsByPool({
      importMap,
      externals: { custom: externals().__GLOBAL__ },
      scopeUrls: SCOPE,
    });
    expect(tears.map(t => t.pool).sort()).toEqual(['custom|fw', 'custom|package:lib']);
  });
});
