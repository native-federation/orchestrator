import { createGetShared } from './get-shared';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockExternal } from 'lib/testing/domain/externals/external.mock';
import { mockSharedVersion } from 'lib/testing/domain/externals/version.mock';
import { GLOBAL_SCOPE, STRICT_SCOPE, type ImportMap, type SharedExternal } from 'lib/core/1.domain';
import { Optional } from 'lib/utils/optional';

const scopeTypeOf = (scope: string): 'global' | 'strict' | 'shareScope' =>
  scope === GLOBAL_SCOPE ? 'global' : scope === STRICT_SCOPE ? 'strict' : 'shareScope';

type SetupOptions = {
  scopes: Record<string, Record<string, SharedExternal>>;
  importMap?: ImportMap;
  /** remoteName -> scopeUrl, used to resolve scoped (non-global) URLs. */
  remotes?: Record<string, string>;
};

const setup = (opts: SetupOptions) => {
  const ports = mockAdapters();
  ports.sharedExternalsRepo.getScopes.mockReturnValue(Object.keys(opts.scopes));
  ports.sharedExternalsRepo.scopeType.mockImplementation((s = GLOBAL_SCOPE) => scopeTypeOf(s));
  ports.sharedExternalsRepo.getFromScope.mockImplementation(
    (s = GLOBAL_SCOPE) => opts.scopes[s] ?? {}
  );
  ports.importMapRepo.get.mockReturnValue(opts.importMap ?? { imports: {} });
  ports.remoteInfoRepo.tryGet.mockImplementation((name: string) => {
    const scopeUrl = opts.remotes?.[name];
    return scopeUrl ? Optional.of({ scopeUrl, exposes: [] }) : Optional.empty();
  });
  return ports;
};

/** Convenience for the common single-global-scope case. */
const global = (
  externals: Record<string, SharedExternal>,
  imports: ImportMap['imports']
): SetupOptions => ({ scopes: { [GLOBAL_SCOPE]: externals }, importMap: { imports } });

describe('createGetShared', () => {
  const NG_URL = 'https://cdn.test/host/core.js';
  const RXJS_URL = 'https://cdn.test/host/rxjs.js';

  describe('global scope', () => {
    it('maps a globally shared external to the webpack MF ShareInfos shape', () => {
      const ports = setup(
        global(
          {
            '@angular/core': mockExternal.shared([
              mockSharedVersion('20.0.0', '@angular/core', {
                remotes: { 'team/host': { requiredVersion: '^20.0.0' } },
                action: 'share',
              }),
            ]),
          },
          { '@angular/core': NG_URL }
        )
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
        global(
          {
            '@angular/core': mockExternal.shared([
              mockSharedVersion('20.0.0', '@angular/core', {
                remotes: ['team/host'],
                action: 'share',
              }),
            ]),
          },
          { '@angular/core': NG_URL }
        )
      );

      expect(createGetShared(ports)()['@angular/core']![0]!.scope).toBeUndefined();
    });

    it('resolves get() through the configured module loader and returns a factory', async () => {
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
          { '@angular/core': NG_URL }
        )
      );
      const module = { ɵcore: true };
      ports.browser.importModule.mockResolvedValue(module);

      const factory = await createGetShared(ports)()['@angular/core']![0]!.get();

      expect(ports.browser.importModule).toHaveBeenCalledWith(NG_URL);
      expect(factory()).toBe(module);
    });

    it('emits multiple shared externals', () => {
      const ports = setup(
        global(
          {
            '@angular/core': mockExternal.shared([
              mockSharedVersion('20.0.0', '@angular/core', {
                remotes: ['team/host'],
                action: 'share',
              }),
            ]),
            rxjs: mockExternal.shared([
              mockSharedVersion('7.8.0', 'rxjs', { remotes: ['team/host'], action: 'share' }),
            ]),
          },
          { '@angular/core': NG_URL, rxjs: RXJS_URL }
        )
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
          { 'dep-a': 'https://cdn.test/a.js', 'dep-b': 'https://cdn.test/b.js' }
        )
      );

      expect(createGetShared(ports)()).toEqual({});
    });

    it('skips a shared external that is absent from the import map', () => {
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
          {} // no resolved URL
        )
      );

      expect(createGetShared(ports)()).toEqual({});
    });

    it('builds requiredVersion from the prefix option (v3-compatible behaviour)', () => {
      const ports = setup(
        global(
          {
            '@angular/core': mockExternal.shared([
              mockSharedVersion('20.0.0', '@angular/core', {
                remotes: { 'team/host': { requiredVersion: '^20.0.0' } },
                action: 'share',
              }),
            ]),
          },
          { '@angular/core': NG_URL }
        )
      );

      expect(
        createGetShared(ports)({ requiredVersionPrefix: '~' })['@angular/core']![0]!.shareConfig
      ).toEqual({ singleton: true, requiredVersion: '~20.0.0' });
    });

    it('honours an empty requiredVersionPrefix (exact version)', () => {
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
          { '@angular/core': NG_URL }
        )
      );

      expect(
        createGetShared(ports)({ requiredVersionPrefix: '' })['@angular/core']![0]!.shareConfig
      ).toEqual({ singleton: true, requiredVersion: '20.0.0' });
    });

    it('respects singleton: false', () => {
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
          { '@angular/core': NG_URL }
        )
      );

      expect(
        createGetShared(ports)({ singleton: false })['@angular/core']![0]!.shareConfig!.singleton
      ).toBe(false);
    });

    it('falls back to a caret range when the shared version has no required range', () => {
      const ports = setup(
        global(
          {
            '@angular/core': mockExternal.shared([
              { tag: '20.0.0', host: true, action: 'share', remotes: [] },
            ]),
          },
          { '@angular/core': NG_URL }
        )
      );

      expect(createGetShared(ports)()['@angular/core']![0]!.shareConfig).toEqual({
        singleton: true,
        requiredVersion: '^20.0.0',
      });
    });

    it('returns an empty config when there are no global externals', () => {
      const ports = setup(global({}, {}));
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
        importMap: {
          imports: {},
          scopes: { 'https://cdn.test/mfe1/': { 'ui-lib': 'https://cdn.test/mfe1/ui-lib.js' } },
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

    it('resolves the scoped URL from the import map scopes, keyed by the providing remote', async () => {
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
        importMap: { imports: {}, scopes: { 'https://cdn.test/mfe1/': { 'ui-lib': URL } } },
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
            'ui-lib': mockExternal.shared([{ tag: '3.0.0', host: false, action: 'share', remotes: [] }]),
          },
        },
        importMap: { imports: {}, scopes: { 'https://cdn.test/mfe1/': { 'ui-lib': 'x' } } },
        remotes: { 'team/mfe1': 'https://cdn.test/mfe1/' },
      });

      expect(createGetShared(ports)()).toEqual({});
    });

    it('skips a scoped external whose remote is not in the import map scopes', () => {
      const ports = setup({
        scopes: {
          'team-a': {
            'ui-lib': mockExternal.shared([
              mockSharedVersion('3.0.0', 'ui-lib', { remotes: ['team/mfe1'], action: 'share' }),
            ]),
          },
        },
        importMap: { imports: {}, scopes: {} },
        remotes: {}, // remote not found
      });

      expect(createGetShared(ports)()).toEqual({});
    });
  });

  describe('strict shareScope', () => {
    it('emits every shared version as a non-singleton, strict-version entry', () => {
      const urlA = 'https://cdn.test/a/ui-lib.js';
      const urlB = 'https://cdn.test/b/ui-lib.js';
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
        importMap: {
          imports: {},
          scopes: {
            'https://cdn.test/a/': { 'ui-lib': urlA },
            'https://cdn.test/b/': { 'ui-lib': urlB },
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
      importMap: {
        imports: { '@angular/core': NG_URL },
        scopes: { 'https://cdn.test/mfe1/': { 'ui-lib': 'https://cdn.test/mfe1/ui-lib.js' } },
      },
      remotes: { 'team/mfe1': 'https://cdn.test/mfe1/' },
    });

    const shared = createGetShared(ports)();

    expect(shared['@angular/core']![0]!.scope).toBeUndefined();
    expect(shared['ui-lib']![0]!.scope).toBe('team-a');
  });
});
