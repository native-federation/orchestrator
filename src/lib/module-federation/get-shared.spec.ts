import { createGetShared } from './get-shared';
import { mockAdapters } from 'lib/testing/adapters.mock';
import { mockExternal } from 'lib/testing/domain/externals/external.mock';
import { mockSharedVersion } from 'lib/testing/domain/externals/version.mock';
import type { ImportMap } from 'lib/core/1.domain';

describe('createGetShared', () => {
  const NG_URL = 'https://cdn.test/host/core.js';
  const RXJS_URL = 'https://cdn.test/host/rxjs.js';

  const setup = (
    globalExternals: Record<string, ReturnType<typeof mockExternal.shared>>,
    imports: ImportMap['imports']
  ) => {
    const ports = mockAdapters();
    ports.sharedExternalsRepo.getFromScope.mockReturnValue(globalExternals);
    ports.importMapRepo.get.mockReturnValue({ imports });
    return ports;
  };

  it('maps a globally shared external to the webpack MF ShareConfig shape', () => {
    const ports = setup(
      {
        '@angular/core': mockExternal.shared([
          mockSharedVersion('20.0.0', '@angular/core', {
            remotes: { 'team/host': { requiredVersion: '^20.0.0' } },
            action: 'share',
          }),
        ]),
      },
      { '@angular/core': NG_URL }
    );

    const shared = createGetShared(ports)();

    expect(Object.keys(shared)).toEqual(['@angular/core']);
    expect(shared['@angular/core']).toHaveLength(1);
    expect(shared['@angular/core']![0]).toMatchObject({
      version: '20.0.0',
      shareConfig: { singleton: true, requiredVersion: '^20.0.0' },
    });
  });

  it('resolves get() through the configured module loader and returns a factory', async () => {
    const ports = setup(
      {
        '@angular/core': mockExternal.shared([
          mockSharedVersion('20.0.0', '@angular/core', {
            remotes: ['team/host'],
            action: 'share',
          }),
        ]),
      },
      { '@angular/core': NG_URL }
    );
    const module = { ɵcore: true };
    ports.browser.importModule.mockResolvedValue(module);

    const shared = createGetShared(ports)();
    const factory = await shared['@angular/core']![0]!.get();

    expect(ports.browser.importModule).toHaveBeenCalledWith(NG_URL);
    expect(factory()).toBe(module);
  });

  it('emits multiple shared externals', () => {
    const ports = setup(
      {
        '@angular/core': mockExternal.shared([
          mockSharedVersion('20.0.0', '@angular/core', { remotes: ['team/host'], action: 'share' }),
        ]),
        rxjs: mockExternal.shared([
          mockSharedVersion('7.8.0', 'rxjs', { remotes: ['team/host'], action: 'share' }),
        ]),
      },
      { '@angular/core': NG_URL, rxjs: RXJS_URL }
    );

    const shared = createGetShared(ports)();

    expect(Object.keys(shared).sort()).toEqual(['@angular/core', 'rxjs']);
  });

  it('skips externals without a shared version (only scoped/skipped)', () => {
    const ports = setup(
      {
        'dep-a': mockExternal.shared([
          mockSharedVersion('1.0.0', 'dep-a', { remotes: ['team/mfe1'], action: 'scope' }),
        ]),
        'dep-b': mockExternal.shared([
          mockSharedVersion('1.0.0', 'dep-b', { remotes: ['team/mfe2'], action: 'skip' }),
        ]),
      },
      { 'dep-a': 'https://cdn.test/a.js', 'dep-b': 'https://cdn.test/b.js' }
    );

    expect(createGetShared(ports)()).toEqual({});
  });

  it('skips a shared external that is absent from the import map', () => {
    const ports = setup(
      {
        '@angular/core': mockExternal.shared([
          mockSharedVersion('20.0.0', '@angular/core', { remotes: ['team/host'], action: 'share' }),
        ]),
      },
      {} // no resolved URL
    );

    expect(createGetShared(ports)()).toEqual({});
  });

  it('builds requiredVersion from the prefix option (v3-compatible behaviour)', () => {
    const ports = setup(
      {
        '@angular/core': mockExternal.shared([
          mockSharedVersion('20.0.0', '@angular/core', {
            remotes: { 'team/host': { requiredVersion: '^20.0.0' } },
            action: 'share',
          }),
        ]),
      },
      { '@angular/core': NG_URL }
    );

    const shared = createGetShared(ports)({ requiredVersionPrefix: '~' });

    expect(shared['@angular/core']![0]!.shareConfig).toEqual({
      singleton: true,
      requiredVersion: '~20.0.0',
    });
  });

  it('honours an empty requiredVersionPrefix (exact version)', () => {
    const ports = setup(
      {
        '@angular/core': mockExternal.shared([
          mockSharedVersion('20.0.0', '@angular/core', { remotes: ['team/host'], action: 'share' }),
        ]),
      },
      { '@angular/core': NG_URL }
    );

    expect(createGetShared(ports)({ requiredVersionPrefix: '' })['@angular/core']![0]!.shareConfig)
      .toEqual({ singleton: true, requiredVersion: '20.0.0' });
  });

  it('respects singleton: false', () => {
    const ports = setup(
      {
        '@angular/core': mockExternal.shared([
          mockSharedVersion('20.0.0', '@angular/core', { remotes: ['team/host'], action: 'share' }),
        ]),
      },
      { '@angular/core': NG_URL }
    );

    expect(createGetShared(ports)({ singleton: false })['@angular/core']![0]!.shareConfig!.singleton)
      .toBe(false);
  });

  it('falls back to a caret range when the shared version has no required range', () => {
    const ports = setup(
      {
        '@angular/core': mockExternal.shared([
          { tag: '20.0.0', host: true, action: 'share', remotes: [] },
        ]),
      },
      { '@angular/core': NG_URL }
    );

    expect(createGetShared(ports)()['@angular/core']![0]!.shareConfig).toEqual({
      singleton: true,
      requiredVersion: '^20.0.0',
    });
  });

  it('returns an empty config when there are no global externals', () => {
    const ports = setup({}, {});
    expect(createGetShared(ports)()).toEqual({});
  });
});
