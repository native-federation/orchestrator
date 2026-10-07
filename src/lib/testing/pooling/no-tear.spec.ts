import type { SharedExternal } from 'lib/core/1.domain';
import { mockVersionRemote } from '../domain/externals/version.mock';
import { emittedUrls, findIncoherentRemotes, findSplitRemotes } from './no-tear';

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
