import type { SharedExternal } from 'lib/core/1.domain';
import { mockVersionRemote } from '../domain/externals/version.mock';
import { emittedUrls, findIncoherentRemotes } from './no-tear';

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
          remotes: [mockVersionRemote('team/mfe-b', '@angular/core', { requiredVersion: '~22.0.5' })],
        },
        {
          tag: '22.1.0',
          host: false,
          action: 'skip',
          remotes: [mockVersionRemote('team/mfe-a', '@angular/core', { requiredVersion: '^22.0.0' })],
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
