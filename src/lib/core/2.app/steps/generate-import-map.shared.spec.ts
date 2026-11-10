import { ForGeneratingImportMap } from '../driver-ports/init/for-generating-import-map';
import { DrivingContract } from '../driving-ports/driving.contract';
import { createGenerateImportMap } from './generate-import-map';
import { LoggingConfig } from '../config/log.contract';
import { ModeConfig } from '../config/mode.contract';
import { NFError } from 'lib/core/native-federation.error';
import { Optional } from 'lib/utils/optional';
import { RemoteInfo } from 'lib/core/1.domain';
import { mockConfig } from 'lib/testing/config.mock';
import { mockAdapters } from 'lib/testing/adapters.mock';
import {
  mockRemoteInfo_HOST,
  mockRemoteInfo_MFE1,
  mockRemoteInfo_MFE2,
} from 'lib/testing/domain/remote-info/remote-info.mock';
import { mockExternal_A } from 'lib/testing/domain/externals/external.mock';
import { mockVersion_A } from 'lib/testing/domain/externals/version.mock';
import {
  mockScopeUrl_HOST,
  mockScopeUrl_MFE1,
  mockScopeUrl_MFE2,
} from 'lib/testing/domain/scope-url.mock';

describe('createGenerateImportMap (shared-externals)', () => {
  let generateImportMap: ForGeneratingImportMap;
  let adapters: Pick<
    DrivingContract,
    'remoteInfoRepo' | 'scopedExternalsRepo' | 'sharedExternalsRepo'
  >;
  let config: LoggingConfig & ModeConfig;

  beforeEach(() => {
    config = mockConfig();
    adapters = mockAdapters();

    adapters.remoteInfoRepo.getAll = vi.fn(() => ({}));
    adapters.scopedExternalsRepo.getAll = vi.fn(() => ({}));
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({}));
    adapters.remoteInfoRepo.tryGet = vi.fn(remote => {
      if (remote === 'team/host') return Optional.of(mockRemoteInfo_HOST({ exposes: [] }));
      if (remote === 'team/mfe1') return Optional.of(mockRemoteInfo_MFE1({ exposes: [] }));
      if (remote === 'team/mfe2') return Optional.of(mockRemoteInfo_MFE2({ exposes: [] }));

      return Optional.empty<RemoteInfo>();
    });

    generateImportMap = createGenerateImportMap(config, adapters);
  });

  it('should add the shared externals to the global scope.', async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [mockVersion_A.v2_1_1({ action: 'share', remotes: ['team/mfe1'] })],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_MFE1({ file: 'dep-a.js' }),
      },
    });
  });

  it('should expand secondary entrypoints (entries) of a globally shared external', async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_1({
            action: 'share',
            remotes: {
              'team/mfe1': { entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' } },
            },
          }),
        ],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_MFE1({ file: 'dep-a.js' }),
        'dep-a/sub': mockScopeUrl_MFE1({ file: 'dep-a-sub.js' }),
      },
    });
  });

  // The serving build is decided before the map, and the claims seed from it; listed second, its copy must
  // still publish, or nobody would.
  it("should publish a share row's serving copy even when another copy leads the row", async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': {
        ...mockExternal_A({
          dirty: false,
          versions: [
            mockVersion_A.v2_1_1({
              action: 'share',
              remotes: {
                'team/mfe1': { entries: { 'dep-a': 'dep-a.js' } },
                'team/mfe2': { entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' } },
              },
            }),
          ],
        }),
        servingBuild: 'team/mfe2',
      },
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_MFE2({ file: 'dep-a.js' }),
        'dep-a/sub': mockScopeUrl_MFE2({ file: 'dep-a-sub.js' }),
      },
    });
  });

  it('should leave a global entrypoint declared only by a skipped version unmapped', async () => {
    // Only share rows claim; a skip copy's entrypoint the shared version lacks stays out of `imports`.
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_3({
            action: 'skip',
            remotes: {
              'team/mfe2': { entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' } },
            },
          }),
          mockVersion_A.v2_1_2({ action: 'share', remotes: ['team/host'] }),
        ],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_HOST({ file: 'dep-a.js' }),
      },
    });
  });

  it('should fill a global entrypoint declared only by a sibling remote of the shared version', async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_1({
            action: 'share',
            remotes: {
              'team/mfe1': { entries: { 'dep-a': 'dep-a.js' } },
              'team/mfe2': { entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' } },
            },
          }),
        ],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_MFE1({ file: 'dep-a.js' }),
        'dep-a/sub': mockScopeUrl_MFE2({ file: 'dep-a-sub.js' }),
      },
    });
  });

  it('should leave a global entrypoint declared only by a non-basis remote of a skip version unmapped', async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_3({
            action: 'skip',
            remotes: {
              'team/mfe1': { entries: { 'dep-a': 'dep-a.js' } },
              'team/mfe2': { entries: { 'dep-a/sub': 'dep-a-sub.js' } },
            },
          }),
          mockVersion_A.v2_1_2({ action: 'share', remotes: ['team/host'] }),
        ],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_HOST({ file: 'dep-a.js' }),
      },
    });
  });

  it('should not fill entrypoints from a losing duplicate share version (different tag)', async () => {
    // Filling from a differently-tagged share version would tear the package across versions.
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_2({
            action: 'share',
            remotes: { 'team/mfe1': { entries: { 'dep-a': 'dep-a.js' } } },
          }),
          mockVersion_A.v2_1_1({
            action: 'share',
            remotes: {
              'team/mfe2': {
                entries: { 'dep-a/sub': 'dep-a-sub.js', 'dep-a/sub/extra': 'dep-a-sub-extra.js' },
              },
            },
          }),
        ],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_MFE1({ file: 'dep-a.js' }),
      },
    });
  });

  it('should only add the shared version of the shared external to the global scope.', async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_3({ action: 'skip', remotes: ['team/mfe2'] }),
          mockVersion_A.v2_1_2({ action: 'share', remotes: ['team/host'] }),
          mockVersion_A.v2_1_1({ action: 'skip', remotes: ['team/mfe1'] }),
        ],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_HOST({ file: 'dep-a.js' }),
      },
    });
  });

  it('should add the scoped version of the shared external to its own scope.', async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_3({ action: 'skip', remotes: ['team/mfe2'] }),
          mockVersion_A.v2_1_2({ action: 'share', remotes: ['team/host'] }),
          mockVersion_A.v2_1_1({ action: 'scope', remotes: ['team/mfe1'] }),
        ],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_HOST({ file: 'dep-a.js' }),
      },
      scopes: {
        [mockScopeUrl_MFE1()]: {
          'dep-a': mockScopeUrl_MFE1({ file: 'dep-a.js' }),
        },
      },
    });
  });

  it('should should scope all remotes in a scoped version.', async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_3({
            action: 'scope',
            remotes: {
              'team/mfe1': { file: 'dep-a-mfe1.js' },
              'team/mfe2': { file: 'dep-a-mfe2.js' },
            },
          }),
        ],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {},
      scopes: {
        [mockScopeUrl_MFE1()]: {
          'dep-a': mockScopeUrl_MFE1({ file: 'dep-a-mfe1.js' }),
        },
        [mockScopeUrl_MFE2()]: {
          'dep-a': mockScopeUrl_MFE2({ file: 'dep-a-mfe2.js' }),
        },
      },
    });
  });

  it('should update the version in storage as "cached".', async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_3({ action: 'share', remotes: ['team/mfe2'] }),
          mockVersion_A.v2_1_1({ action: 'scope', remotes: ['team/mfe1'] }),
        ],
      }),
    }));

    await generateImportMap();

    expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
      'dep-a',
      mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_3({ action: 'share', remotes: { 'team/mfe2': { cached: true } } }),
          mockVersion_A.v2_1_1({ action: 'scope', remotes: { 'team/mfe1': { cached: true } } }),
        ],
      })
    );
  });

  it('should not update the version in storage if it is already "cached".', async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_3({ action: 'share', remotes: { 'team/mfe2': { cached: true } } }),
          mockVersion_A.v2_1_1({ action: 'scope', remotes: { 'team/mfe1': { cached: true } } }),
        ],
      }),
    }));

    await generateImportMap();

    expect(adapters.sharedExternalsRepo.addOrUpdate).not.toHaveBeenCalled();
  });

  it('should warn the user about 2 shared versions and choose the most recent one if in non-strict mode.', async () => {
    config.strict.strictImportMap = false;

    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_3({ action: 'share', remotes: ['team/mfe2'] }),
          mockVersion_A.v2_1_1({ action: 'share', remotes: ['team/mfe1'] }),
        ],
      }),
    }));
    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_MFE2({ file: 'dep-a.js' }),
      },
    });
    expect(config.log.warn).toHaveBeenCalledWith(
      4,
      'Singleton external dep-a has multiple shared versions.'
    );
  });

  it('should throw error if 2 shared versions and in strict mode.', async () => {
    config.strict.strictImportMap = true;

    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_3({ action: 'share', remotes: ['team/mfe2'] }),
          mockVersion_A.v2_1_1({ action: 'share', remotes: ['team/mfe1'] }),
        ],
      }),
    }));

    await expect(generateImportMap()).rejects.toEqual(new NFError('Could not create ImportMap.'));
    expect(config.log.error).toHaveBeenCalledWith(
      4,
      '[dep-a] Shared external has multiple shared versions.'
    );
  });

  // A flat build emits `dep-a/sub` as an external of its own; at the shared tag it is the same version, not a
  // second one, and it adds no file of its own build beside the root's.
  it('should not report a flat secondary external at the dense root tag as a second shared version', async () => {
    config.strict.strictImportMap = true;

    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_1({
            action: 'share',
            remotes: {
              'team/mfe1': { entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' } },
            },
          }),
        ],
      }),
      'dep-a/sub': mockExternal_A({
        dirty: false,
        versions: [
          mockVersion_A.v2_1_1({
            action: 'share',
            remotes: {
              'team/mfe2': {
                entries: { 'dep-a/sub': 'dep-a-sub.js', 'dep-a/sub/extra': 'dep-a-sub-extra.js' },
              },
            },
          }),
        ],
      }),
    }));

    const actual = await generateImportMap();

    expect(actual).toEqual({
      imports: {
        'dep-a': mockScopeUrl_MFE1({ file: 'dep-a.js' }),
        'dep-a/sub': mockScopeUrl_MFE1({ file: 'dep-a-sub.js' }),
      },
    });
    expect(config.log.warn).not.toHaveBeenCalled();
    expect(config.log.error).not.toHaveBeenCalled();
  });

  it('should throw an error if the remote doesnt exist', async () => {
    adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
      'dep-a': mockExternal_A({
        dirty: false,
        versions: [mockVersion_A.v2_1_3({ action: 'share', remotes: ['team/mfe3'] })],
      }),
    }));

    await expect(generateImportMap()).rejects.toThrow('Could not create ImportMap.');
    expect(config.log.error).toHaveBeenCalledWith(
      4,
      `[__GLOBAL__][dep-a][team/mfe3] Remote name not found in cache.`
    );
  });

  /**
   * Pooling placed some remotes in a subpool: each copy names the build it runs (`servedBy`), and its scope
   * maps that build's files. These pin the global path through the map and the stored `cached` marks only,
   * so they hold whatever the path looks like inside.
   */
  describe('servedBy builds', () => {
    const HASH = 'sha384-MFE2';

    beforeEach(() => {
      adapters.remoteInfoRepo.tryGet = vi.fn(remote => {
        if (remote === 'team/host') return Optional.of(mockRemoteInfo_HOST({ exposes: [] }));
        if (remote === 'team/mfe1') return Optional.of(mockRemoteInfo_MFE1({ exposes: [] }));
        if (remote === 'team/mfe2')
          return Optional.of({
            ...mockRemoteInfo_MFE2({ exposes: [] }),
            integrity: { 'dep-a.js': HASH, 'dep-a-sub.js': HASH, 'dep-a-sub-flat.js': HASH },
          });
        return Optional.empty<RemoteInfo>();
      });
    });

    // The host publishes 2.1.3; mfe1 and mfe2 form a subpool on mfe2's 2.1.2, stored as pooling stores it:
    // the subpool build's own copy names itself too.
    it("should map a subpool member onto its build's file, with its integrity, and mark that copy cached", async () => {
      const record = {
        'dep-a': mockExternal_A({
          versions: [
            mockVersion_A.v2_1_3({ action: 'share', remotes: ['team/host'] }),
            mockVersion_A.v2_1_2({
              action: 'skip',
              remotes: {
                'team/mfe2': { servedBy: 'team/mfe2' },
                'team/mfe1': { servedBy: 'team/mfe2' },
              },
            }),
          ],
        }),
      };
      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => record);

      const actual = await generateImportMap();

      const served = mockScopeUrl_MFE2({ file: 'dep-a.js' });
      expect(actual).toEqual({
        imports: { 'dep-a': mockScopeUrl_HOST({ file: 'dep-a.js' }) },
        scopes: {
          [mockScopeUrl_MFE2()]: { 'dep-a': served },
          [mockScopeUrl_MFE1()]: { 'dep-a': served },
        },
        integrity: { [served]: HASH },
      });
      // Pins the serving copy's cached mark, which the dynamic path reads as what the committed map serves.
      expect(record['dep-a'].versions[1]!.remotes.map(r => [r.name, r.cached])).toEqual([
        ['team/mfe2', true],
        ['team/mfe1', false],
      ]);
      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
        'dep-a',
        record['dep-a']
      );
    });

    // A hand-built record pinning a defensive branch: one pool run cannot produce it, since a secondary joins
    // its package's pool and the subpool's owner goes global only once no member needs it (election.ts
    // `promote`). mfe2 declares `dep-a/sub` as a package of its own beside its dense `dep-a`, which ships the
    // same file; the flat record is stored first, as a skip. mfe1 runs mfe2's build, whose file `imports`
    // already maps.
    it('should drop a scope entry that repeats `imports`, and leave its copy unmarked', async () => {
      const record = {
        'dep-a/sub': mockExternal_A({
          versions: [
            mockVersion_A.v2_1_2({
              action: 'skip',
              remotes: {
                'team/mfe2': { entries: { 'dep-a/sub': 'dep-a-sub.js' } },
                'team/mfe1': { entries: { 'dep-a/sub': 'dep-a-sub.js' }, servedBy: 'team/mfe2' },
              },
            }),
          ],
        }),
        'dep-a': mockExternal_A({
          versions: [
            mockVersion_A.v2_1_2({
              action: 'share',
              remotes: {
                'team/mfe2': { entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' } },
              },
            }),
          ],
        }),
      };
      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => record);

      const actual = await generateImportMap();

      expect(actual).toEqual({
        imports: {
          'dep-a': mockScopeUrl_MFE2({ file: 'dep-a.js' }),
          'dep-a/sub': mockScopeUrl_MFE2({ file: 'dep-a-sub.js' }),
        },
        integrity: {
          [mockScopeUrl_MFE2({ file: 'dep-a.js' })]: HASH,
          [mockScopeUrl_MFE2({ file: 'dep-a-sub.js' })]: HASH,
        },
      });
      // The served source is mfe2's flat copy (first in record order), which `imports` does not publish: a
      // dropped entry must not mark it.
      expect(record['dep-a/sub'].versions[0]!.remotes[0]!.cached).toBe(false);
      expect(adapters.sharedExternalsRepo.addOrUpdate).toHaveBeenCalledWith(
        'dep-a',
        record['dep-a']
      );
    });

    // mfe2 ships `dep-a/sub` in two records with different files: its dense `dep-a` first, its flat
    // `dep-a/sub` after. The first in record order serves. Hand-built: mfe2's own copy lacks the self-servedBy
    // pooling writes, which this does not need.
    it('should serve a specifier from the first copy of the build that lists it', async () => {
      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-a': mockExternal_A({
          versions: [
            mockVersion_A.v2_1_3({
              action: 'share',
              remotes: {
                'team/host': { entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' } },
              },
            }),
            mockVersion_A.v2_1_2({
              action: 'skip',
              remotes: {
                'team/mfe1': {
                  entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' },
                  servedBy: 'team/mfe2',
                },
                'team/mfe2': { entries: { 'dep-a': 'dep-a.js', 'dep-a/sub': 'dep-a-sub.js' } },
              },
            }),
          ],
        }),
        'dep-a/sub': mockExternal_A({
          versions: [
            mockVersion_A.v2_1_2({
              action: 'skip',
              remotes: { 'team/mfe2': { entries: { 'dep-a/sub': 'dep-a-sub-flat.js' } } },
            }),
          ],
        }),
      }));

      const actual = await generateImportMap();

      expect(actual.scopes).toEqual({
        [mockScopeUrl_MFE1()]: {
          'dep-a': mockScopeUrl_MFE2({ file: 'dep-a.js' }),
          'dep-a/sub': mockScopeUrl_MFE2({ file: 'dep-a-sub.js' }),
        },
      });
    });

    // mfe2's build no longer ships `dep-a/sub` or `dep-a/x`, but mfe1's stored copy still names it for them.
    // One warning per such specifier: two, so the count also pins that a stale specifier does not end the
    // remote's scan. The wording is deliberately unpinned: it belongs to the maintainer, and pooling wording
    // is pinned only in `pooling/island-warnings.contract.spec.ts`.
    it('should warn per specifier a servedBy build does not serve, and leave it unmapped', async () => {
      adapters.sharedExternalsRepo.getFromScope = vi.fn(() => ({
        'dep-a': mockExternal_A({
          versions: [
            mockVersion_A.v2_1_3({ action: 'share', remotes: ['team/host'] }),
            mockVersion_A.v2_1_2({
              action: 'skip',
              remotes: {
                'team/mfe2': { servedBy: 'team/mfe2' },
                'team/mfe1': {
                  entries: {
                    'dep-a': 'dep-a.js',
                    'dep-a/sub': 'dep-a-sub.js',
                    'dep-a/x': 'dep-a-x.js',
                  },
                  servedBy: 'team/mfe2',
                },
              },
            }),
          ],
        }),
      }));

      const actual = await generateImportMap();

      expect(actual.scopes?.[mockScopeUrl_MFE1()]).toEqual({
        'dep-a': mockScopeUrl_MFE2({ file: 'dep-a.js' }),
      });
      expect(config.log.warn).toHaveBeenCalledTimes(2);
      expect(config.log.warn).toHaveBeenCalledWith(4, expect.any(String));
    });
  });
});
