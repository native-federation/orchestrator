import { type SharedInfo, type DenseSharedInfo } from './remote-entry.contract';
import {
  densifyExternals,
  toDenseSharedInfoFormat,
} from '@softarc/native-federation/internal/browser';
/**
 * These two functions are the only entry points that normalize a raw remoteEntry's `shared`
 * array into the dense format the rest of the pipeline assumes. Which one runs is chosen by
 * `config.feature.convertFlatSharedInfo` (see remote-entry-provider.ts):
 *
 *   convertFlatSharedInfo: true  -> densifyExternals        ("denseExternals ON":  groups secondary
 *                                                             entrypoints under their parent package)
 *   convertFlatSharedInfo: false -> toDenseSharedInfoFormat ("denseExternals OFF": 1:1 flat -> dense)
 *
 * Orthogonally, bundler chunks reach these functions in one of two shapes ("denseChunking"):
 *
 *   denseChunking OFF -> chunks arrive as flat `@nf-internal/*` entries INSIDE the `shared` array
 *   denseChunking ON  -> chunks arrive via the separate `remoteEntry.chunks` property, so the
 *                        `shared` array these functions see contains NO `@nf-internal/*` entries
 *
 * The permutations below pin all 4 combinations. The invariant both functions must uphold: a
 * `@nf-internal/*` chunk is emitted in dense format, keyed by its FULL name, never grouped under
 * a shared `@nf-internal` parent, and identically regardless of the denseExternals branch.
 */
describe('remote-entry.contract normalization', () => {
  const flat = (packageName: string, o: Partial<SharedInfo> = {}): SharedInfo => ({
    singleton: false,
    strictVersion: true,
    requiredVersion: '~2.2.0',
    version: '2.2.2',
    packageName,
    outFileName: `${packageName}.js`,
    ...o,
  });

  const CHUNK = () =>
    flat('@nf-internal/x-chunk', {
      outFileName: 'x-chunk.js',
      bundle: 'bundle-1',
      pool: 'pool-1',
    });

  const DENSE_CHUNK: DenseSharedInfo = {
    singleton: false,
    strictVersion: true,
    requiredVersion: '~2.2.0',
    version: '2.2.2',
    packageName: '@nf-internal/x-chunk',
    bundle: 'bundle-1',
    pool: 'pool-1',
    entries: { '@nf-internal/x-chunk': 'x-chunk.js' },
  };

  describe('denseExternals ON (densifyExternals)', () => {
    it('[+denseChunking OFF] converts an inline @nf-internal chunk to dense, keyed by full name', () => {
      const [result] = densifyExternals([CHUNK()]);

      expect(result).toEqual(DENSE_CHUNK);
      expect(result).not.toHaveProperty('outFileName');
    });

    it('[+denseChunking OFF] never groups distinct chunks under a shared @nf-internal parent', () => {
      const result = densifyExternals([
        flat('@nf-internal/a-chunk', { outFileName: 'a.js' }),
        flat('@nf-internal/b-chunk', { outFileName: 'b.js' }),
      ]);

      expect(result).toHaveLength(2);
      expect(result.map(e => e.packageName)).toEqual([
        '@nf-internal/a-chunk',
        '@nf-internal/b-chunk',
      ]);
      expect((result[0] as DenseSharedInfo).entries).toEqual({ '@nf-internal/a-chunk': 'a.js' });
      expect((result[1] as DenseSharedInfo).entries).toEqual({ '@nf-internal/b-chunk': 'b.js' });
    });

    it('[+denseChunking ON] passes a chunk-free shared array through the grouping logic only', () => {
      // No @nf-internal entries: the chunk branch must never fire; real externals still densify.
      const result = densifyExternals([
        flat('@ng/common', { outFileName: 'common.js' }),
        flat('@ng/common/http', { outFileName: 'http.js' }),
      ]);

      // Secondary entrypoint folds into its parent package.
      expect(result).toHaveLength(1);
      expect(result[0]!.packageName).toBe('@ng/common');
      expect((result[0] as DenseSharedInfo).entries).toEqual({
        '@ng/common': 'common.js',
        '@ng/common/http': 'http.js',
      });
    });

    it('groups real externals while keeping an inline chunk separate and ungrouped', () => {
      const result = densifyExternals([
        flat('@ng/common', { outFileName: 'common.js' }),
        CHUNK(),
        flat('@ng/common/http', { outFileName: 'http.js' }),
      ]);

      expect(result).toHaveLength(2);
      const chunk = result.find(e => e.packageName === '@nf-internal/x-chunk');
      const grouped = result.find(e => e.packageName === '@ng/common') as DenseSharedInfo;
      expect(chunk).toEqual(DENSE_CHUNK);
      expect(grouped.entries).toEqual({
        '@ng/common': 'common.js',
        '@ng/common/http': 'http.js',
      });
    });

    it('passes already-dense entries through unchanged', () => {
      const [result] = densifyExternals([DENSE_CHUNK]);
      expect(result).toBe(DENSE_CHUNK);
    });
  });

  describe('denseExternals OFF (toDenseSharedInfoFormat)', () => {
    it('[+denseChunking OFF] converts an inline @nf-internal chunk to dense 1:1', () => {
      const [result] = toDenseSharedInfoFormat([CHUNK()]);

      expect(result).toEqual(DENSE_CHUNK);
      expect(result).not.toHaveProperty('outFileName');
    });

    it('[+denseChunking ON] converts a chunk-free shared array 1:1 without grouping', () => {
      const result = toDenseSharedInfoFormat([
        flat('@ng/common', { outFileName: 'common.js' }),
        flat('@ng/common/http', { outFileName: 'http.js' }),
      ]);

      // No grouping: each entrypoint stays its own dense entry keyed by its own name.
      expect(result).toHaveLength(2);
      expect((result[0] as DenseSharedInfo).entries).toEqual({ '@ng/common': 'common.js' });
      expect((result[1] as DenseSharedInfo).entries).toEqual({ '@ng/common/http': 'http.js' });
    });

    it('passes already-dense entries through unchanged', () => {
      const [result] = toDenseSharedInfoFormat([DENSE_CHUNK]);
      expect(result).toBe(DENSE_CHUNK);
    });
  });

  it('both branches densify an inline chunk to an identical shape (denseExternals-agnostic)', () => {
    const [viaDensify] = densifyExternals([CHUNK()]);
    const [viaToDense] = toDenseSharedInfoFormat([CHUNK()]);

    expect(viaDensify).toEqual(viaToDense);
    expect(viaDensify).toEqual(DENSE_CHUNK);
  });
});
