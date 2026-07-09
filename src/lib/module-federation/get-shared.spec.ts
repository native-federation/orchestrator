import { createGetShared } from './get-shared';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockExternal } from 'lib/testing/domain/externals/external.mock';
import { mockSharedVersion } from 'lib/testing/domain/externals/version.mock';
import { GLOBAL_SCOPE, STRICT_SCOPE, type SharedExternal } from 'lib/core/1.domain';
import { Optional } from 'lib/utils/optional';

const scopeTypeOf = (scope: string): 'global' | 'strict' | 'shareScope' =>
  scope === GLOBAL_SCOPE ? 'global' : scope === STRICT_SCOPE ? 'strict' : 'shareScope';

type SetupOptions = {
  scopes: Record<string, Record<string, SharedExternal>>;
  /** remoteName -> scopeUrl, used to derive every external's resolved URL. */
  remotes?: Record<string, string>;
};

const HOST_SCOPE = 'https://cdn.test/host/';

const setup = (opts: SetupOptions) => {
  const ports = mockAdapters();
  ports.sharedExternalsRepo.getScopes.mockReturnValue(Object.keys(opts.scopes));
  ports.sharedExternalsRepo.scopeType.mockImplementation((s = GLOBAL_SCOPE) => scopeTypeOf(s));
  ports.sharedExternalsRepo.getFromScope.mockImplementation(
    (s = GLOBAL_SCOPE) => opts.scopes[s] ?? {}
  );
  ports.remoteInfoRepo.tryGet.mockImplementation((name: string) => {
    const scopeUrl = opts.remotes?.[name];
    return scopeUrl ? Optional.of({ scopeUrl, exposes: [] }) : Optional.empty();
  });
  return ports;
};

/** Convenience for the common single-global-scope case. */
const global = (
  externals: Record<string, SharedExternal>,
  remotes: Record<string, string> = { 'team/host': HOST_SCOPE }
): SetupOptions => ({ scopes: { [GLOBAL_SCOPE]: externals }, remotes });

describe('createGetShared', () => {
  // Derived as `join(scopeUrl, version.remotes[0].file)`, mirroring generate-import-map.
  const NG_URL = 'https://cdn.test/host/@angular/core.js';
  const RXJS_URL = 'https://cdn.test/host/rxjs.js';

  describe('global scope', () => {
    it('maps a globally shared external to the webpack MF ShareInfos shape', () => {
      const ports = setup(
        global({
          '@angular/core': mockExternal.shared([
            mockSharedVersion('20.0.0', '@angular/core', {
              remotes: { 'team/host': { requiredVersion: '^20.0.0' } },
              action: 'share',
            }),
          ]),
        })
      );

      const shared = createGetShared(ports)();

      expect(Object.keys(shared)).toEqual(['@angular/core']);
      expect(shared['@angular/core']).toHaveLength(1);
      expect(shared['@angular/core']![0]).toMatchObject({
        version: '20.0.0',
        shareConfig: { singleton: true, requiredVersion: '^20.0.0' },
      });
    });

    it('does not set a scope for global externals (MF uses its default scope)', () => {
      const ports = setup(
        global({
          '@angular/core': mockExternal.shared([
            mockSharedVersion('20.0.0', '@angular/core', {
              remotes: ['team/host'],
              action: 'share',
            }),
          ]),
        })
      );

      expect(createGetShared(ports)()['@angular/core']![0]!.scope).toBeUndefined();
    });

    it('resolves get() through the configured module loader and returns a factory', async () => {
      const ports = setup(
        global({
          '@angular/core': mockExternal.shared([
            mockSharedVersion('20.0.0', '@angular/core', {
              remotes: ['team/host'],
              action: 'share',
            }),
          ]),
        })
      );
      const module = { ɵcore: true };
      ports.browser.importModule.mockResolvedValue(module);

      const factory = await createGetShared(ports)()['@angular/core']![0]!.get();

      expect(ports.browser.importModule).toHaveBeenCalledWith(NG_URL);
      expect(factory()).toBe(module);
    });

    it('emits multiple shared externals', () => {
      const ports = setup(
        global({
          '@angular/core': mockExternal.shared([
            mockSharedVersion('20.0.0', '@angular/core', {
              remotes: ['team/host'],
              action: 'share',
            }),
          ]),
          rxjs: mockExternal.shared([
            mockSharedVersion('7.8.0', 'rxjs', { remotes: ['team/host'], action: 'share' }),
          ]),
        })
      );

      expect(Object.keys(createGetShared(ports)()).sort()).toEqual(['@angular/core', 'rxjs']);
    });

    it('skips externals without a shared version (only scoped/skipped)', () => {
      const ports = setup(
        global(
          {
            'dep-a': mockExternal.shared([
              mockSharedVersion('1.0.0', 'dep-a', { remotes: ['team/mfe1'], action: 'scope' }),
            ]),
            'dep-b': mockExternal.shared([
              mockSharedVersion('1.0.0', 'dep-b', { remotes: ['team/mfe2'], action: 'skip' }),
            ]),
          },
          { 'team/mfe1': 'https://cdn.test/mfe1/', 'team/mfe2': 'https://cdn.test/mfe2/' }
        )
      );

      expect(createGetShared(ports)()).toEqual({});
    });

    it('skips a shared external whose providing remote is not registered', () => {
      const ports = setup(
        global(
          {
            '@angular/core': mockExternal.shared([
              mockSharedVersion('20.0.0', '@angular/core', {
                remotes: ['team/host'],
                action: 'share',
              }),
            ]),
          },
          {} // remote not found -> no resolvable URL
        )
      );

      expect(createGetShared(ports)()).toEqual({});
    });

    it('builds requiredVersion from the prefix option (v3-compatible behaviour)', () => {
      const ports = setup(
        global({
          '@angular/core': mockExternal.shared([
            mockSharedVersion('20.0.0', '@angular/core', {
              remotes: { 'team/host': { requiredVersion: '^20.0.0' } },
              action: 'share',
            }),
          ]),
        })
      );

      expect(
        createGetShared(ports)({ requiredVersionPrefix: '~' })['@angular/core']![0]!.shareConfig
      ).toEqual({ singleton: true, requiredVersion: '~20.0.0' });
    });

    it('honours an empty requiredVersionPrefix (exact version)', () => {
      const ports = setup(
        global({
          '@angular/core': mockExternal.shared([
            mockSharedVersion('20.0.0', '@angular/core', {
              remotes: ['team/host'],
              action: 'share',
            }),
          ]),
        })
      );

      expect(
        createGetShared(ports)({ requiredVersionPrefix: '' })['@angular/core']![0]!.shareConfig
      ).toEqual({ singleton: true, requiredVersion: '20.0.0' });
    });

    it('respects singleton: false', () => {
      const ports = setup(
        global({
          '@angular/core': mockExternal.shared([
            mockSharedVersion('20.0.0', '@angular/core', {
              remotes: ['team/host'],
              action: 'share',
            }),
          ]),
        })
      );

      expect(
        createGetShared(ports)({ singleton: false })['@angular/core']![0]!.shareConfig!.singleton
      ).toBe(false);
    });

    it('falls back to a caret range when the shared version has no required range', () => {
      const ports = setup(
        global({
          '@angular/core': mockExternal.shared([
            {
              tag: '20.0.0',
              host: true,
              action: 'share',
              remotes: [
                {
                  name: 'team/host',
                  file: '@angular/core.js',
                  requiredVersion: '',
                  strictVersion: true,
                  cached: false,
                  entries: { '@angular/core': '@angular/core.js' },
                },
              ],
            },
          ]),
        })
      );

      expect(createGetShared(ports)()['@angular/core']![0]!.shareConfig).toEqual({
        singleton: true,
        requiredVersion: '^20.0.0',
      });
    });

    it('emits only the first shared version when a global external has several', () => {
      const ports = setup(
        global(
          {
            'ui-lib': mockExternal.shared([
              mockSharedVersion('1.0.0', 'ui-lib', {
                remotes: { 'team/host': { file: 'ui-lib-1.js' } },
                action: 'share',
              }),
              mockSharedVersion('2.0.0', 'ui-lib', {
                remotes: { 'team/mfe1': { file: 'ui-lib-2.js' } },
                action: 'share',
              }),
            ]),
          },
          { 'team/host': HOST_SCOPE, 'team/mfe1': 'https://cdn.test/mfe1/' }
        )
      );

      const entries = createGetShared(ports)()['ui-lib'];

      expect(entries).toHaveLength(1);
      expect(entries![0]).toMatchObject({ version: '1.0.0', shareConfig: { singleton: true } });
    });

    it('returns an empty config when there are no global externals', () => {
      const ports = setup(global({}));
      expect(createGetShared(ports)()).toEqual({});
    });
  });

  describe('custom shareScope', () => {
    it('maps a custom shareScope external to MF`s scope property', () => {
      const ports = setup({
        scopes: {
          [GLOBAL_SCOPE]: {},
          'team-a': {
            'ui-lib': mockExternal.shared([
              mockSharedVersion('3.0.0', 'ui-lib', {
                remotes: { 'team/mfe1': { requiredVersion: '^3.0.0', file: 'ui-lib.js' } },
                action: 'share',
              }),
            ]),
          },
        },
        remotes: { 'team/mfe1': 'https://cdn.test/mfe1/' },
      });

      const shared = createGetShared(ports)();

      expect(shared['ui-lib']).toHaveLength(1);
      expect(shared['ui-lib']![0]).toMatchObject({
        version: '3.0.0',
        scope: 'team-a',
        shareConfig: { singleton: true, requiredVersion: '^3.0.0' },
      });
      expect(shared['ui-lib']![0]!.shareConfig!.strictVersion).toBeUndefined();
    });

    it('resolves the scoped URL from the providing remote`s scope', async () => {
      const URL = 'https://cdn.test/mfe1/ui-lib.js';
      const ports = setup({
        scopes: {
          'team-a': {
            'ui-lib': mockExternal.shared([
              mockSharedVersion('3.0.0', 'ui-lib', {
                remotes: { 'team/mfe1': { file: 'ui-lib.js' } },
                action: 'share',
              }),
            ]),
          },
        },
        remotes: { 'team/mfe1': 'https://cdn.test/mfe1/' },
      });
      ports.browser.importModule.mockResolvedValue({ ui: true });

      await createGetShared(ports)()['ui-lib']![0]!.get();

      expect(ports.browser.importModule).toHaveBeenCalledWith(URL);
    });

    it('skips a scoped shared version that has no providing remote', () => {
      const ports = setup({
        scopes: {
          'team-a': {
            'ui-lib': mockExternal.shared([
              { tag: '3.0.0', host: false, action: 'share', remotes: [] },
            ]),
          },
        },
        remotes: { 'team/mfe1': 'https://cdn.test/mfe1/' },
      });

      expect(createGetShared(ports)()).toEqual({});
    });

    it('skips a scoped external whose remote is not registered', () => {
      const ports = setup({
        scopes: {
          'team-a': {
            'ui-lib': mockExternal.shared([
              mockSharedVersion('3.0.0', 'ui-lib', { remotes: ['team/mfe1'], action: 'share' }),
            ]),
          },
        },
        remotes: {}, // remote not found
      });

      expect(createGetShared(ports)()).toEqual({});
    });
  });

  describe('strict shareScope', () => {
    it('emits every shared version as a non-singleton, strict-version entry', () => {
      const ports = setup({
        scopes: {
          [STRICT_SCOPE]: {
            'ui-lib': mockExternal.shared([
              mockSharedVersion('15.2.1', 'ui-lib', {
                remotes: { 'team/a': { requiredVersion: '15.2.1', file: 'ui-lib.js' } },
                action: 'share',
              }),
              mockSharedVersion('16.0.0', 'ui-lib', {
                remotes: { 'team/b': { requiredVersion: '16.0.0', file: 'ui-lib.js' } },
                action: 'share',
              }),
            ]),
          },
        },
        remotes: { 'team/a': 'https://cdn.test/a/', 'team/b': 'https://cdn.test/b/' },
      });

      const entries = createGetShared(ports)()['ui-lib'];

      expect(entries).toHaveLength(2);
      entries!.forEach(entry => {
        expect(entry.scope).toBe(STRICT_SCOPE);
        expect(entry.shareConfig).toMatchObject({ singleton: false, strictVersion: true });
      });
      expect(entries!.map(e => [e.version, e.shareConfig!.requiredVersion])).toEqual([
        ['15.2.1', '15.2.1'],
        ['16.0.0', '16.0.0'],
      ]);
    });

    it('pins requiredVersion to the exact tag even when the remote negotiated a range', () => {
      const ports = setup({
        scopes: {
          [STRICT_SCOPE]: {
            'ui-lib': mockExternal.shared([
              mockSharedVersion('15.2.1', 'ui-lib', {
                remotes: { 'team/a': { requiredVersion: '^15.0.0', file: 'ui-lib.js' } },
                action: 'share',
              }),
            ]),
          },
        },
        remotes: { 'team/a': 'https://cdn.test/a/' },
      });

      // A range would let MF resolve any compatible version from the map; strict
      // must only reuse the exact version, so the tag wins over the '^15.0.0' range.
      expect(createGetShared(ports)()['ui-lib']![0]!.shareConfig!.requiredVersion).toBe('15.2.1');
    });

    it('stays non-singleton and emits every version even when singleton is forced on', () => {
      const ports = setup({
        scopes: {
          [STRICT_SCOPE]: {
            'ui-lib': mockExternal.shared([
              mockSharedVersion('15.2.1', 'ui-lib', {
                remotes: { 'team/a': { requiredVersion: '15.2.1', file: 'ui-lib.js' } },
                action: 'share',
              }),
              mockSharedVersion('16.0.0', 'ui-lib', {
                remotes: { 'team/b': { requiredVersion: '16.0.0', file: 'ui-lib.js' } },
                action: 'share',
              }),
            ]),
          },
        },
        remotes: { 'team/a': 'https://cdn.test/a/', 'team/b': 'https://cdn.test/b/' },
      });

      const entries = createGetShared(ports)({ singleton: true })['ui-lib'];

      // Forcing singleton must not collapse the strict version -> location map.
      expect(entries).toHaveLength(2);
      entries!.forEach(entry => expect(entry.shareConfig!.singleton).toBe(false));
    });
  });

  it('bridges global and custom shareScope externals together', () => {
    const ports = setup({
      scopes: {
        [GLOBAL_SCOPE]: {
          '@angular/core': mockExternal.shared([
            mockSharedVersion('20.0.0', '@angular/core', {
              remotes: ['team/host'],
              action: 'share',
            }),
          ]),
        },
        'team-a': {
          'ui-lib': mockExternal.shared([
            mockSharedVersion('3.0.0', 'ui-lib', {
              remotes: { 'team/mfe1': { file: 'ui-lib.js' } },
              action: 'share',
            }),
          ]),
        },
      },
      remotes: { 'team/host': HOST_SCOPE, 'team/mfe1': 'https://cdn.test/mfe1/' },
    });

    const shared = createGetShared(ports)();

    expect(shared['@angular/core']![0]!.scope).toBeUndefined();
    expect(shared['ui-lib']![0]!.scope).toBe('team-a');
  });
});
